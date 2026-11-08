// POST /api/fight  { fighterA, fighterB, reuseArt? }  ->
//   { winner: "A" | "B", reasoning, images: { A: Art, B: Art } }
//   where Art is { src: "data:image/jpeg;base64,..." }
//            or { error: { type: "image_blocked" | "image_failed", message } }
//            or { reused: true } for a side listed in reuseArt (e.g. ["A"]): a
//               fighter picked from the BattleDex, whose saved art the client
//               already has, so no new image is generated for it.
//
// One call per fight: rate limit, validate, then the Claude verdict and both
// fighters' OpenAI art run in parallel. A failed verdict fails the whole fight;
// a failed image only fails that side, so the verdict still shows.

const Anthropic = require("@anthropic-ai/sdk").default;
const { betaZodOutputFormat } = require("@anthropic-ai/sdk/helpers/beta/zod");
const { z } = require("zod");
const { JUDGE_SYSTEM_PROMPT, buildJudgeUserMessage } = require("./_lib/judge-prompt");
const { generateFighterImage } = require("./_lib/fighter-art");
const { describeFighters, pickPoses } = require("./_lib/fighter-looks");

const MODEL = "claude-sonnet-5-5";
const MAX_FIGHTER_LENGTH = 50; // matches MAX_FIGHTER_LENGTH in script.js and the inputs' maxlength

// ---------------------------------------------------------------------------
// Verdict schema: the only definition of the output shape. The judge prompt has
// no format instructions; field meanings live in .describe().
// ---------------------------------------------------------------------------
const VerdictSchema = z.object({
  winner: z
    .enum(["A", "B"])
    .describe(
      '"A" if the fighter in <fighter_a> wins, "B" if the fighter in <fighter_b> wins. ' +
        "Always exactly one; never a tie.",
    ),
  reasoning: z
    .string()
    .describe("3 to 5 sentences of playful but logical reasoning explaining why the winner won."),
});

// ---------------------------------------------------------------------------
// Rate limiting: 5 requests per minute per IP, sliding window.
// In-memory, so it's per server instance: exact under `vercel dev`, best-effort
// on Vercel where requests can land on different instances.
// ---------------------------------------------------------------------------
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;
const hits = new Map(); // ip -> timestamps of requests inside the window

function checkRateLimit(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);

  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    const retryAfterSec = Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 1000);
    return { allowed: false, retryAfterSec };
  }

  recent.push(now);
  hits.set(ip, recent);

  // Drop idle IPs so the map doesn't grow forever.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (now - times[times.length - 1] >= RATE_WINDOW_MS) hits.delete(key);
    }
  }
  return { allowed: true };
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

// ---------------------------------------------------------------------------

function sendError(res, status, type, message) {
  res.status(status).json({ error: { type, message } });
}

function readFighters(body) {
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return { error: "That challenge came in garbled. Try again!" };
    }
  }
  const fighterA = typeof body?.fighterA === "string" ? body.fighterA.trim() : "";
  const fighterB = typeof body?.fighterB === "string" ? body.fighterB.trim() : "";

  if (!fighterA || !fighterB) return { error: "We need a challenger in both corners before the bell can ring!" };
  if (fighterA.length > MAX_FIGHTER_LENGTH || fighterB.length > MAX_FIGHTER_LENGTH) {
    return { error: `Whoa, that's a mouthful! The ring announcer can't shout a name that long. Keep each fighter to ${MAX_FIGHTER_LENGTH} characters or fewer.` };
  }
  const reuseArt = new Set(
    Array.isArray(body?.reuseArt) ? body.reuseArt.filter((side) => side === "A" || side === "B") : [],
  );
  return { fighterA, fighterB, reuseArt };
}

let client; // created on first use so a missing key fails per request, not at import
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

async function judgeFight(fighterA, fighterB) {
  const message = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildJudgeUserMessage(fighterA, fighterB) }],
    output_config: {
      effort: "low", // short, playful verdict; keeps the wait down
      format: betaZodOutputFormat(VerdictSchema),
    },
    // If a safety classifier declines, the API re-runs the request on a fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });

  if (message.stop_reason === "refusal") {
    throw new VerdictError("The judges refuse to call this one! Try a different matchup.");
  }
  if (message.stop_reason === "max_tokens" || !message.parsed_output) {
    throw new VerdictError("The judge's scorecard got cut off mid-sentence. Ring the bell again!");
  }
  return message.parsed_output;
}

class VerdictError extends Error {}

// Maps a verdict failure to the status and message the UI shows.
function verdictErrorResponse(err) {
  if (err instanceof VerdictError) return [502, err.message];
  if (err instanceof Anthropic.RateLimitError) {
    // Anthropic's limit, not ours: report as busy so the UI doesn't confuse it with our 429.
    return [503, "The judges are buried in scorecards right now. Give them a moment, then try again."];
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return [500, "The judges' booth is locked: the API key was rejected. The arena crew needs to fix this."];
  }
  if (err instanceof Anthropic.APIConnectionError) return [504, "We lost contact with the judges' booth. Ring the bell again!"];
  if (err instanceof Anthropic.APIError) return [502, "The judges' booth had a malfunction. Ring the bell again!"];
  // AnthropicError without a status: e.g. the structured output failed zod validation.
  return [502, "The judge's scorecard came back scrambled. Ring the bell again!"];
}

// Never rejects: resolves to { src } or { error: { type, message } }.
// `looks` is a promise of { A, B } descriptions (or null); `side` is "A" or "B".
async function settleArt(fighter, side, looks, pose, signal) {
  const description = (await looks)?.[side];
  return generateFighterImage(fighter, { signal, description, pose }).then(
    (src) => ({ src }),
    (err) => ({ error: { type: err.type || "image_failed", message: err.message } }),
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "method_not_allowed", "Use POST.");
  }

  // 1. Rate limit before anything else touches an API.
  const limit = checkRateLimit(clientIp(req));
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    return sendError(
      res,
      429,
      "rate_limited",
      `That's 5 fights in a minute, and the arena needs a breather! Back in the ring in ${limit.retryAfterSec}s.`,
    );
  }

  // 2. Validate input.
  const input = readFighters(req.body);
  if (input.error) return sendError(res, 400, "bad_request", input.error);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set");
    return sendError(res, 500, "verdict_failed", "The judges haven't shown up yet: the API key is missing. The arena crew needs to set it up.");
  }

  // 3. Verdict and both images, in parallel.
  const art = new AbortController();
  // Art: Claude first describes both fighters (so book characters look like the
  // book), then each side is drawn in its own random pose. Sides reusing saved
  // BattleDex art skip all of this.
  const drawA = !input.reuseArt.has("A");
  const drawB = !input.reuseArt.has("B");
  const looks = drawA || drawB ? describeFighters(input.fighterA, input.fighterB, { signal: art.signal }) : null;
  const poses = pickPoses();
  const artA = drawA ? settleArt(input.fighterA, "A", looks, poses.A, art.signal) : Promise.resolve({ reused: true });
  const artB = drawB ? settleArt(input.fighterB, "B", looks, poses.B, art.signal) : Promise.resolve({ reused: true });

  let verdict;
  try {
    verdict = await judgeFight(input.fighterA, input.fighterB);
  } catch (err) {
    console.error("Verdict failed:", err);
    art.abort(); // no verdict means no result to show, so stop drawing
    const [status, message] = verdictErrorResponse(err);
    return sendError(res, status, "verdict_failed", message);
  }

  const [imageA, imageB] = await Promise.all([artA, artB]);
  return res.status(200).json({
    winner: verdict.winner,
    reasoning: verdict.reasoning,
    images: { A: imageA, B: imageB },
  });
};
