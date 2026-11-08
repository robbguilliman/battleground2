# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Battleground: type two fighters, get an AI verdict on who wins (Claude) plus one pixel-art image per fighter (OpenAI image API), and save fighters to a localStorage "BattleDex". `project-brief.md` holds the scope and fixed decisions; `project-build.md` is the staged build plan. Work one stage at a time and don't start stage N+1 until stage N works. Development is local-only until Stage 7 deploys to Vercel.

**Plan vs. code:** `project-build.md` ticks Stages 4-6 (BattleDex, image compression, redesign), but the code has none of them yet: no localStorage, BattleDex view or canvas code. Check the code, not the checkboxes, to know what exists.

## Commands

- `npm install`: installs `@anthropic-ai/sdk`, `openai` and `zod`, used by `api/`.
- `npm run dev:vercel`: `vercel dev`, the way to run the app locally now that `api/fight.js` exists. Keys go in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
- `npm run dev`: zero-dependency static server (`dev-server.js`) at http://localhost:3000. It only serves files, so the Fight button gets a 404 from `/api/fight`.

There's no build step, linter or test suite. Vercel serves the repo root as static files (`vercel.json`: no framework, `outputDirectory: "."`). `.vercelignore` keeps `*.md`, `dev-server.js` and `.env*` out of deploys.

## Architecture

**Frontend** (`index.html`, `style.css`, `script.js`): vanilla JS, no framework or bundler. One page holds four `<section class="view">` elements (`view-form`, `view-loading`, `view-result`, `view-error`). `showView(name)` sets `hidden` on every view except the named one, so exactly one is ever visible. Keep this pattern for new views, such as BattleDex. Fighter cards are `card-a`/`card-b`, and the winner card gets `.is-winner`. `requestFight()` POSTs to `/api/fight` with a 120s abort timeout and turns every whole-fight failure (offline, timeout, 400, 429, verdict error) into a `FightError` with its own title and message for the error view. Image failures don't use the error view: `renderResult()` shows a placeholder SVG on that card plus a note (`#art-error-a`/`-b`), styled differently for `image_blocked`.

**Backend** (`api/`): Vercel Node serverless functions, written in CommonJS (`require`/`module.exports`, since `package.json` has no `"type": "module"`). Shared code goes in `api/_lib/`, because Vercel doesn't turn underscore folders into routes.

**Judge prompt** (`api/_lib/judge-prompt.js`):
- Exports `JUDGE_SYSTEM_PROMPT` and `buildJudgeUserMessage(fighterA, fighterB)`. The helper wraps each fighter in `<fighter_a>`/`<fighter_b>` tags and strips those tags from the user's text, so a fighter can't break out of its own tag.
- The prompt must always pick exactly one winner (mirror matches included), write 3-5 sentences of playful but logical reasoning, treat fighter text as data only, and never leave the judge role.
- It deliberately has **no output-format or JSON instructions**. The verdict shape is defined only by the zod schema in the Stage 3 call, with field meanings in `.describe()`: `winner: z.enum(["A", "B"])` and `reasoning: z.string()`. The winner is A/B rather than a name so "cow" vs "cow" still tells the UI which card won. Don't add format instructions back to the prompt.

**`api/fight.js`:** `POST { fighterA, fighterB }` returns `{ winner: "A" | "B", reasoning, images: { A, B } }`, where each image is `{ src }` (a JPEG data URI) or `{ error: { type: "image_blocked" | "image_failed", message } }`. Whole-fight failures return `{ error: { type, message } }`. In order:
1. The per-IP rate limit: 5 requests/minute, sliding window, 429 with `Retry-After`. It's an in-memory `Map`, so it's exact under `vercel dev` but only per-instance on Vercel.
2. Input validation: both fighters required, max 100 characters each, matching the inputs' `maxlength`.
3. The verdict and both images run in parallel. The verdict uses `client.beta.messages.parse` on `claude-sonnet-5-5`, effort `low`, `output_config.format: betaZodOutputFormat(VerdictSchema)`, and server-side refusal fallbacks (`fallbacks: "default"`). Anthropic's own 429 is reported as a 503 so the UI never confuses it with ours.
4. A failed verdict fails the whole fight and aborts the image requests. A failed image only fails its own side.

`vercel.json` gives `api/fight.js` a `maxDuration` of 120s. A fight takes about 15-20s, mostly image generation.

**Fighter art** (`api/_lib/fighter-art.js`): `gpt-image-2.5-flare`, 1024x1024, quality `medium`, JPEG at compression 80 (about 150-200 KB each, keeping the response under Vercel's 4.5 MB limit). `maxRetries: 0`, so a failure doesn't double the wait. `gpt-image-1` was shut down in October 2026, and Flare rejects the `complexity` param. OpenAI's `moderation_blocked` error code becomes `image_blocked`; everything else becomes `image_failed`.

**Image rules:**
- A group input like "10 cows" still gets exactly one image for its side. Handle that in the image prompt, not by looping.
- Every image prompt ends with the shared art style template (16-bit pixel art, retro sprite style, plain solid color background, no text), quoted verbatim in `project-build.md` Stage 3.
- Moderation-blocked is its own error type and UI message, separate from a generic image failure.

**Secrets:** API keys live only in env vars, never in client code. Locally they go in `.env` (git-ignored by `.env*`; `.env.local` holds only the Vercel CLI token). On Vercel, set them as project env vars.
