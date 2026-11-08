// Fighter art: one OpenAI image per side, every image in the shared art style.

const OpenAI = require("openai").default;

const IMAGE_MODEL = "gpt-image-2.5-flare"; // OpenAI's fast everyday image model

// Shared art style template (project-build.md, Stage 3). Appended verbatim to
// every image prompt so the model never falls back to its default style.
const ART_STYLE_TEMPLATE =
  "16-bit pixel art illustration, retro video game sprite style, bold outlined pixels, vibrant " +
  "limited color palette, dynamic action pose. Depicted as one cohesive image, centered, filling " +
  "most of the frame, isolated on a plain solid color background with no scenery. No text, words, " +
  "letters, numbers, logos, watermarks, UI elements, borders, or frames.";

// Group inputs ("10 cows") are handled here in the prompt: one image showing the
// whole group, never one image per unit. `description` (from fighter-looks.js)
// pins down the character's appearance; `pose` is that side's random pose.
function buildImagePrompt(fighter, { description, pose } = {}) {
  return (
    `Character art of one fighter for an arcade fighting game. The fighter is: "${fighter}". ` +
    (description
      ? "Draw them exactly as described here, keeping every detail of skin color, hair, build, " +
        `clothing and attributes: ${description} `
      : "") +
    (pose ? `Pose: ${pose}. ` : "") +
    "Show only this fighter, with no opponent. If the fighter is a group or a number of things, " +
    "show the whole group together as one unit in a single image.\n\n" +
    ART_STYLE_TEMPLATE
  );
}

class ImageError extends Error {
  // type: "image_blocked" (OpenAI content moderation) or "image_failed" (anything else)
  constructor(type, message) {
    super(message);
    this.type = type;
  }
}

let client;
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 100_000, // stays inside the function's maxDuration in vercel.json
      maxRetries: 0, // a retry would double an already long wait
    });
  }
  return client;
}

function isModerationBlock(err) {
  const code = err.code || err.error?.code;
  return code === "moderation_blocked" || code === "content_policy_violation";
}

/**
 * Generates one fighter's art. Resolves to a data URI, or throws an ImageError.
 * `signal` lets the caller cancel the request (e.g. when the verdict fails).
 * `description` and `pose` come from fighter-looks.js; both are optional.
 */
async function generateFighterImage(fighter, { signal, description, pose } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new ImageError("image_failed", "The artist isn't set up yet (missing API key).");
  }

  try {
    const result = await getClient().images.generate(
      {
        model: IMAGE_MODEL,
        prompt: buildImagePrompt(fighter, { description, pose }),
        n: 1,
        size: "1024x1024",
        quality: "medium",
        background: "opaque",
        output_format: "jpeg",
        output_compression: 80, // keeps two images well under Vercel's response size limit
      },
      { signal },
    );

    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new ImageError("image_failed", "The artist came back with a blank canvas.");
    return `data:image/jpeg;base64,${b64}`;
  } catch (err) {
    if (err instanceof ImageError) throw err;
    if (signal?.aborted) throw new ImageError("image_failed", "Cancelled.");
    if (isModerationBlock(err)) {
      throw new ImageError(
        "image_blocked",
        "This fighter couldn't be drawn because it was blocked by the image safety filter. Try a different fighter.",
      );
    }
    console.error(`Image failed for "${fighter}": ${err.message}`, err.requestID ? `(request ${err.requestID})` : "");
    if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
      throw new ImageError("image_failed", "The artist isn't set up correctly (API key rejected).");
    }
    if (err instanceof OpenAI.RateLimitError) {
      throw new ImageError("image_failed", "The artist is swamped right now. Try again in a moment.");
    }
    throw new ImageError("image_failed", "The artist couldn't finish this fighter's portrait.");
  }
}

module.exports = { ART_STYLE_TEMPLATE, buildImagePrompt, generateFighterImage, ImageError };
