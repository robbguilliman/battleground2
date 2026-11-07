// POST /api/fight  { fighterA, fighterB }  ->  { winner: "A" | "B", reasoning }
//
// Stage 3, verdict half only: rate limit, then one Claude call for the verdict.
// Image generation is not wired in yet.

const Anthropic = require("@anthropic-ai/sdk").default;
const { betaZodOutputFormat } = require("@anthropic-ai/sdk/helpers/beta/zod");
const { z } = require("zod");
const { JUDGE_SYSTEM_PROMPT, buildJudgeUserMessage } = require("./_lib/judge-prompt");

const MODEL = "claude-sonnet-5-5";
const MAX_FIGHTER_LENGTH = 100; // matches the inputs' maxlength in index.html

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
      return { error: "Request body must be JSON." };
    }
  }
  const fighterA = typeof body?.fighterA === "string" ? body.fighterA.trim() : "";
  const fighterB = typeof body?.fighterB === "string" ? body.fighterB.trim() : "";

  if (!fighterA || !fighterB) return { error: "Both fighters need a name before they can fight." };
  if (fighterA.length > MAX_FIGHTER_LENGTH || fighterB.length > MAX_FIGHTER_LENGTH) {
    return { error: `Fighter names can be at most ${MAX_FIGHTER_LENGTH} characters.` };
  }
  return { fighterA, fighterB };
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
    throw new VerdictError("The judge refused to rule on this fight. Try different fighters.");
  }
  if (message.stop_reason === "max_tokens" || !message.parsed_output) {
    throw new VerdictError("The judge's verdict came back incomplete. Please try again.");
  }
  return message.parsed_output;
}

class VerdictError extends Error {}

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
      `Whoa, slow down! You can start 5 fights a minute. Try again in ${limit.retryAfterSec}s.`,
    );
  }

  // 2. Validate input.
  const input = readFighters(req.body);
  if (input.error) return sendError(res, 400, "bad_request", input.error);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set");
    return sendError(res, 500, "verdict_failed", "The judge isn't set up yet (missing API key).");
  }

  // 3. Verdict.
  try {
    const verdict = await judgeFight(input.fighterA, input.fighterB);
    return res.status(200).json({ winner: verdict.winner, reasoning: verdict.reasoning });
  } catch (err) {
    console.error("Verdict failed:", err);

    if (err instanceof VerdictError) {
      return sendError(res, 502, "verdict_failed", err.message);
    }
    if (err instanceof Anthropic.RateLimitError) {
      // Anthropic's limit, not ours: report as busy so the UI doesn't confuse it with our 429.
      return sendError(res, 503, "verdict_failed", "The judge is swamped right now. Try again in a moment.");
    }
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return sendError(res, 500, "verdict_failed", "The judge isn't set up correctly (API key rejected).");
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return sendError(res, 504, "verdict_failed", "Couldn't reach the judge. Please try again.");
    }
    if (err instanceof Anthropic.APIError) {
      return sendError(res, 502, "verdict_failed", "The judge ran into a problem. Please try again.");
    }
    // AnthropicError without a status: e.g. the structured output failed zod validation.
    return sendError(res, 502, "verdict_failed", "The judge's verdict didn't make sense. Please try again.");
  }
};
