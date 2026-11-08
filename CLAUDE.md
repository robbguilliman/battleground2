# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Battleground: type two fighters, get an AI verdict on who wins (Claude) plus one pixel-art image per fighter (OpenAI image API), and save fighters to a localStorage "BattleDex". `project-brief.md` holds the scope and fixed decisions; `project-build.md` is the staged build plan. Work one stage at a time and don't start stage N+1 until stage N works. Development is local-only until Stage 7 deploys to Vercel.

**Progress:** Stages 0-5 are built (scaffold, UI shell, judge prompt, fight API with verdict and art, BattleDex, image compression). Stages 6-7 (Claude redesign, final QA and deploy) are not started.

## Commands

- `npm install`: installs `@anthropic-ai/sdk`, `openai` and `zod`, used by `api/`.
- `npm run dev:vercel`: `vercel dev`, the way to run the app locally now that `api/fight.js` exists. Keys go in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
- `npm run dev`: zero-dependency static server (`dev-server.js`) at http://localhost:3000. It only serves files, so the Fight button gets a 404 from `/api/fight`.

There's no build step, linter or test suite. Vercel serves the repo root as static files (`vercel.json`: no framework, `outputDirectory: "."`). `.vercelignore` keeps `*.md`, `dev-server.js` and `.env*` out of deploys.

## Architecture

**Frontend:** vanilla JS, no framework or bundler, two pages sharing `style.css`. `index.html` + `script.js` is the fight page. `battledex.html` + `battledex.js` is the BattleDex. `dex-store.js` holds the storage helpers and is loaded by both. `index.html` holds four `<section class="view">` elements (`view-form`, `view-loading`, `view-result`, `view-error`). `showView(name)` sets `hidden` on every view except the named one, so exactly one is ever visible. Keep this pattern for new views. Fighter cards are `card-a`/`card-b`, and the winner card gets `.is-winner`. `requestFight()` POSTs to `/api/fight` with a 120s abort timeout and turns every whole-fight failure (offline, timeout, 400, 429, verdict error) into a `FightError` with its own title and message for the error view. Image failures don't use the error view: `renderResult()` shows a placeholder SVG on that card plus a note (`#art-error-a`/`-b`), styled differently for `image_blocked`.

**BattleDex:** saved fighters live in `localStorage` under `battleground.battledex` as an array of `{ id, label, image, sourceKey }`, with no fight data. On save, `compressImage()` (in `dex-store.js`) redraws the art on an off-screen canvas at 512px and re-exports it as WebP at quality 0.8, or JPEG where WebP encoding isn't supported. That's about 30-65K characters per fighter instead of about 200K, so roughly 100 fighters fit in the quota. `sourceKey` is a fingerprint of the full-size original (`imageKey()`), so the result view can still tell a fighter is already saved. `battledex.html` compresses any entry over 120K characters once (fighters saved before Stage 5). If compression fails, the original is saved instead. Save buttons are on the result view (`script.js`). Viewing, removing and clearing happen on `battledex.html`. Every storage read and write is wrapped in try/catch, and a full quota shows a message instead of throwing. Cards are built with `textContent`, never `innerHTML`. The card itself isn't clickable; its controls are Pick and remove.

**Picking saved fighters:** on `battledex.html`, up to two cards can be picked. "Fight with picked" writes them to `sessionStorage` (`battleground.picks`) and opens `index.html#picked`, which reads them once, fills the form and shows a "From your BattleDex" badge. On submit, picked sides whose name is unchanged are sent as `reuseArt: ["A"|"B"]`. The API skips image generation for those sides and returns `{ reused: true }`, and the client puts the saved image back in. Editing a picked name drops the pick.

**Last fight across pages:** each result is also written to `sessionStorage` (`battleground.lastFight`, as `{ fighterA, fighterB, verdict }`), so it lasts for the tab, survives a reload and is gone in a new tab. "Back to last fight" on `battledex.html` links to `index.html#last-fight`, which re-renders that result and then clears the hash. A fighter already in the BattleDex shows "Saved ✓", matched by `sourceKey` or by image.

**Backend** (`api/`): Vercel Node serverless functions, written in CommonJS (`require`/`module.exports`, since `package.json` has no `"type": "module"`). Shared code goes in `api/_lib/`, because Vercel doesn't turn underscore folders into routes.

**Judge prompt** (`api/_lib/judge-prompt.js`):
- Exports `JUDGE_SYSTEM_PROMPT` and `buildJudgeUserMessage(fighterA, fighterB)`. The helper wraps each fighter in `<fighter_a>`/`<fighter_b>` tags and strips those tags from the user's text, so a fighter can't break out of its own tag.
- The prompt must always pick exactly one winner (mirror matches included), write 3-5 sentences of playful but logical reasoning, treat fighter text as data only, and never leave the judge role.
- It deliberately has **no output-format or JSON instructions**. The verdict shape is defined only by the zod schema in the Stage 3 call, with field meanings in `.describe()`: `winner: z.enum(["A", "B"])` and `reasoning: z.string()`. The winner is A/B rather than a name so "cow" vs "cow" still tells the UI which card won. Don't add format instructions back to the prompt.

**`api/fight.js`:** `POST { fighterA, fighterB, reuseArt? }` returns `{ winner: "A" | "B", reasoning, images: { A, B } }`, where each image is `{ src }` (a JPEG data URI), `{ error: { type: "image_blocked" | "image_failed", message } }`, or `{ reused: true }` for a side listed in `reuseArt`. Whole-fight failures return `{ error: { type, message } }`. In order:
1. The per-IP rate limit: 5 requests/minute, sliding window, 429 with `Retry-After`. It's an in-memory `Map`, so it's exact under `vercel dev` but only per-instance on Vercel.
2. Input validation: both fighters required, max 50 characters each. The same limit is the inputs' `maxlength` and `MAX_FIGHTER_LENGTH` in both `script.js` and `api/fight.js`; keep all three in sync.
3. The verdict and both images run in parallel. The verdict uses `client.beta.messages.parse` on `claude-sonnet-5-5`, effort `low`, `output_config.format: betaZodOutputFormat(VerdictSchema)`, and server-side refusal fallbacks (`fallbacks: "default"`). Anthropic's own 429 is reported as a 503 so the UI never confuses it with ours.
4. A failed verdict fails the whole fight and aborts the image requests. A failed image only fails its own side.

`vercel.json` gives `api/fight.js` a `maxDuration` of 120s. A fight takes about 15-20s, mostly image generation.

**Fighter looks** (`api/_lib/fighter-looks.js`): `describeFighters()` makes one extra Claude call per fight (`claude-sonnet-5-5`, effort `low`, zod-structured `{ fighterA, fighterB }`). It writes a 40-80 word appearance description of each fighter, with book characters described as the source text describes them. It runs in parallel with the verdict, and both images wait for it. It resolves to `null` on any failure, and the art then falls back to the name alone. `pickPoses()` picks two different random poses from `POSES`, with A facing right and B facing left. Sides in `reuseArt` skip both steps.

**Fighter art** (`api/_lib/fighter-art.js`): the image prompt is the fighter name, then the description, then the pose, then the group rule, then the style template. `gpt-image-2.5-flare`, 1024x1024, quality `medium`, JPEG at compression 80 (about 150-200 KB each, keeping the response under Vercel's 4.5 MB limit). `maxRetries: 0`, so a failure doesn't double the wait. `gpt-image-1` was shut down in October 2026, and Flare rejects the `complexity` param. OpenAI's `moderation_blocked` error code becomes `image_blocked`; everything else becomes `image_failed`.

**Image rules:**
- A group input like "10 cows" still gets exactly one image for its side. Handle that in the image prompt, not by looping.
- Every image prompt ends with the shared art style template (16-bit pixel art, retro sprite style, plain solid color background, no text), quoted verbatim in `project-build.md` Stage 3.
- Moderation-blocked is its own error type and UI message, separate from a generic image failure.

**Voice:** all user-facing copy, errors included, uses a playful arena-announcer voice ("Empty corner!", "Whoa, easy, champ!"), but every message still says what went wrong and what to do next. Error text comes from the API (`api/fight.js`, `fighter-art.js`), with client fallbacks in `requestFight()`. The loading quips are `LOADING_MESSAGES` in `script.js`. They're `aria-hidden` and rotate as a shuffled deck while the loading view is shown.

**Secrets:** API keys live only in env vars, never in client code. Locally they go in `.env` (git-ignored by `.env*`; `.env.local` holds only the Vercel CLI token). On Vercel, set them as project env vars.
