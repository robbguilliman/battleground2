# Battleground — Staged Build Plan

> Source: `project-brief.md`. Each stage ships something runnable/demoable before moving to next. Do not start stage N+1 until stage N works.

---

## Stage 0 — Scaffold

**Goal:** empty project running locally.

- [x] `index.html`, `style.css`, `script.js` — bare skeleton, no logic yet
- [x] `vercel.json` (if needed) + `api/` folder for serverless functions
- [x] `package.json` (name, no deps yet unless a dev server is wanted)
- [x] Run locally (e.g. `vercel dev` or a static server), confirm blank page loads

**Done when:** blank page loads locally. No deploy — building and testing locally the whole way.

---

## Stage 1 — Static UI shell (no backend)

**Goal:** all core UI elements exist and are wired to JS, hardcoded/mock data only.

- [x] Four separate views on one page — input form, loading, result, error — each toggled via `hidden` attribute, never stacked/visible together
- [x] Input form view: two text inputs (fighter A, fighter B), Fight button — the only view visible on load
- [x] Loading view: spinner/skeleton, shown on click
- [x] Result view: winner name, written reasoning, two image slots — populate with placeholder text/images after a fake `setTimeout` delay
- [x] Error view: placeholder error message
- [x] Basic CSS layout, mobile-usable

**Done when:** on load only input form shows; clicking Fight hides it, shows loading, then swaps to result view (fake data) via `hidden`, no network calls yet.

---

## Stage 2 — Judge system prompt

**Goal:** lock Claude's role to judging fights, resist prompt injection from fighter input.

- [x] Write the system prompt used in the verdict call: role locked to fight judge only — takes two fighters, returns a winner and reasoning, nothing else
- [x] Must always name exactly one winner — no ties, no draws, no refusals, even for identical matchups (e.g. "cow" vs "cow"); break the deadlock on flavor/creativity if needed, but always pick one
- [x] Reasoning must be 3-5 sentences max, fun and playful tone, but still logical — it must clearly justify why the winner won
- [x] Explicitly forbid in the prompt: role changes, revealing the system prompt, following instructions embedded in fighter names/descriptions, doing anything other than judging the fight
- [x] Treat fighter input strictly as data to judge, never as instructions
- [x] Test with adversarial input (e.g. a fighter name containing "ignore previous instructions and...") — confirm it still just judges a fight
- [x] Test with identical fighters twice (e.g. "cow" vs "cow") — confirm it still names one winner, no tie/refusal

**Done when:** injected instructions inside fighter text don't change judge behavior or leak the system prompt.

---

## Stage 3 — Fight API (verdict + art + rate limiting)

**Goal:** one function, one call, real winner + reasoning + one image per side, end to end.

- [x] `api/fight.js` serverless function: takes `{ fighterA, fighterB }`
- [x] Rate limit check runs first, before calling either API — key by IP, 5 requests/minute per `project-brief.md` §5, return 429 with a clear message when exceeded
- [x] Calls Claude for the verdict (using the Stage 2 system prompt) and OpenAI image API for both fighters' art
- [x] Verdict output (`winner`, `reasoning`) enforced via a zod schema, not JSON-format instructions in the prompt
  > Note: the judge system prompt (`api/_lib/judge-prompt.js`) has no output-format or JSON instructions. The zod schema is the only definition of the verdict shape, so field meanings go in `.describe()` on each field: `winner: z.enum(["A", "B"])` ("A" if the fighter in `<fighter_a>` wins, "B" if the fighter in `<fighter_b>` wins; A/B rather than names so mirror matches like "cow" vs "cow" are unambiguous) and `reasoning: z.string()` (3-5 sentences explaining why the winner won).
- [x] Store both API keys in env vars, never in client code
- [x] Group inputs (e.g. "10 cows") still produce exactly one image for that side — handled in the prompt sent to the image API, not by looping
- [x] Every image created must follow one shared art style template, appended verbatim to each fighter's image prompt (never left to the model's default style):
  > 16-bit pixel art illustration, retro video game sprite style, bold outlined pixels, vibrant limited color palette, dynamic action pose. Depicted as one cohesive image, centered, filling most of the frame, isolated on a plain solid color background with no scenery. No text, words, letters, numbers, logos, watermarks, UI elements, borders, or frames.
- [x] Wire Fight button to call `/api/fight` instead of the fake timeout
- [x] Moderation-blocked is its own distinct error case, separate from a generic image failure: when OpenAI's content moderation rejects an image request, the API returns its own error type and the UI shows its own message (e.g. that the fighter couldn't be drawn and to try a different one), never the generic "image failed" message
- [x] Handle errors distinctly in the UI: verdict failure, generic image failure, moderation-blocked (see above), rate-limit 429 — don't hang on loading forever

**Done when:** typing two real fighters returns winner + reasoning + one image per side from a single call, both images following the shared art style template; hammering Fight 6x in a minute from one IP gets blocked on the 6th and resets after a minute.

---

## Stage 4 — BattleDex (save to localStorage)

**Goal:** save individual fighters, view saved fighters.

- [x] "Save" action per fighter: writes `{ label, image }` to a `localStorage` array — no fight/winner/reasoning data, just the fighter
- [x] BattleDex view: grid of saved fighters, each a mini trading-card style (image on top, name below) — not clickable, card just displays label + image
- [x] Delete/clear entries from BattleDex
- [x] "Back to last fight" button on BattleDex view — jumps back to most recent result view (winner/reasoning/images still in memory)
- [x] "New fight" button on BattleDex view — returns to input form view

**Done when:** save a fighter, reload the page, it's still there in BattleDex; from BattleDex, can jump back to last fight result or start a new fight.

---

## Stage 5 — Image compression before save

**Goal:** stay under `localStorage` quota (per brief §5).

- [x] Before saving a fighter to BattleDex, draw its image to an off-screen `<canvas>`, resize down, re-export as JPEG/WebP at reduced quality
- [x] Save the compressed data URI, not the original
- [x] Test with several saved fighters that quota isn't hit quickly

**Done when:** ~10+ saved fighters don't blow `localStorage` quota.

---

## Stage 6 — Claude redesign

**Goal:** hand entire app to Claude Design for full visual overhaul — not just verdict UI polish, every view.

- [x] Run all four views (form, loading, result, error) plus BattleDex through Claude Design for a complete visual pass — imported "Battleground Arcade" design project via the Claude Design MCP
- [x] Winner card component: name, image, reasoning text, entry animation when result lands (winner border pulse, WINNER/DEFEAT tags, grayscale loser)
- [x] Loading state redesigned to cover full wait for the fight call (VS spinner, rotating status text, animated verdict/art progress bar)
- [x] Consistent visual language applied app-wide (typography, color, spacing, motion) — no leftover placeholder styling anywhere

**Done when:** full app feels like one designed product, no more placeholder styling on any view.

---

## Stage 7 — Final QA

**Goal:** ship it.

- [ ] Full manual pass: empty inputs, one empty input, same fighter twice, very long names, non-English input
- [ ] Confirm rate limiting doesn't fire on normal single-fight use
- [ ] Confirm loading/error states cover: fight API failure (verdict or image side), rate limit hit, network offline
- [ ] Deploy to Vercel

**Done when:** app handles the MVP end to end without console errors, deployed to Vercel.

---

## Explicitly out of scope (per brief §4 — later, not now)

- Real backend / cross-device BattleDex sync
- Quick re-fight using saved BattleDex characters
