# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Battleground: type two fighters, get an AI verdict on who wins (Claude) plus one pixel-art image per fighter (OpenAI image API), and save fighters to a localStorage "BattleDex". `project-brief.md` holds the scope and fixed decisions; `project-build.md` is the staged build plan. Work one stage at a time and don't start stage N+1 until stage N works. Development is local-only until Stage 7 deploys to Vercel.

**Plan vs. code:** `project-build.md` ticks Stages 4-6 (BattleDex, image compression, redesign), but the code has none of them yet. `script.js` is still the Stage 1 mock shell with no localStorage, BattleDex view or canvas code. Check the code, not the checkboxes, to know what exists.

## Commands

- `npm run dev`: zero-dependency static server (`dev-server.js`) at http://localhost:3000. It only serves files and does not run `/api` functions.
- `npm run dev:vercel`: `vercel dev`, needed from Stage 3 onward to run the serverless functions in `api/`.

There's no build step, linter or test suite. Vercel serves the repo root as static files (`vercel.json`: no framework, `outputDirectory: "."`). `.vercelignore` keeps `*.md`, `dev-server.js` and `.env*` out of deploys.

## Architecture

**Frontend** (`index.html`, `style.css`, `script.js`): vanilla JS, no framework or bundler. One page holds four `<section class="view">` elements (`view-form`, `view-loading`, `view-result`, `view-error`). `showView(name)` sets `hidden` on every view except the named one, so exactly one is ever visible. Keep this pattern for new views, such as BattleDex. Fighter cards are `card-a`/`card-b`, and the winner card gets `.is-winner`. In Stage 3, the `setTimeout` in `mockFight` will be replaced by a call to `/api/fight`.

**Backend** (`api/`): Vercel Node serverless functions, written in CommonJS (`require`/`module.exports`, since `package.json` has no `"type": "module"`). Shared code goes in `api/_lib/`, because Vercel doesn't turn underscore folders into routes.

**Judge prompt** (`api/_lib/judge-prompt.js`):
- Exports `JUDGE_SYSTEM_PROMPT` and `buildJudgeUserMessage(fighterA, fighterB)`. The helper wraps each fighter in `<fighter_a>`/`<fighter_b>` tags and strips those tags from the user's text, so a fighter can't break out of its own tag.
- The prompt must always pick exactly one winner (mirror matches included), write 4-6 sentences of playful but logical reasoning, treat fighter text as data only, and never leave the judge role.
- It deliberately has **no output-format or JSON instructions**. The verdict shape is defined only by the zod schema in the Stage 3 call, with field meanings in `.describe()`: `winner: z.enum(["A", "B"])` and `reasoning: z.string()`. The winner is A/B rather than a name so "cow" vs "cow" still tells the UI which card won. Don't add format instructions back to the prompt.

**Planned `api/fight.js` (Stage 3):**
- One request takes `{ fighterA, fighterB }` and returns the verdict plus both images.
- The per-IP rate limit (5 requests/minute) runs before either API is called and returns 429 when exceeded.
- The UI must show different messages for a failed verdict, a failed image, an image blocked by moderation, and a 429.

**Image rules:**
- A group input like "10 cows" still gets exactly one image for its side. Handle that in the image prompt, not by looping.
- Every image prompt ends with the shared 16-bit pixel-art style template, quoted verbatim in `project-build.md` Stage 3.

**Secrets:** API keys live only in env vars (`.env.local`, git-ignored), never in client code. Stage 3 needs `ANTHROPIC_API_KEY` and an OpenAI key added there.
