# Battleground — Project Brief
## 1. What are we actually building? (Scope)

A web app where you type in two fighters and get an AI generated verdict on who'd win, plus AI generated character art for both.

## 2. What's the smallest, simplest version worth shipping (MVP)?

Two text inputs, a Fight button, a working verdict with art, a loading state while we wait on the API, and a basic BattleDex saved to localStorage. Type two fighters, get a real result, save it if you want.

## 3. What are we building this with (tech stack)?

HTML, CSS, and vanilla JS for the frontend. Vercel for hosting and serverless functions. Claude's API for the verdict. OpenAI's image API for the character art. localStorage for saving BattleDex.

## 4. What's the long-term vision, beyond just the MVP?

I would eventually like a real backend where BattleDex characters sync across devices instead of just living in localStorage. I'd also want a quick re-fight option using characters already saved in the BattleDex, instead of typing two new ones every time.

## 5. Details decided so far

- **Rate limiting**: 5 requests per minute per IP.
- **Verdict format**: winner card with animation, plus written reasoning for the win.
- **Character art**: one image per side. Group inputs (e.g. "10 cows vs 10 lions") still get one image per side, not one per unit.
- **Image storage**: images downsized/compressed client-side (canvas resize + JPEG/WebP quality) before saving to localStorage, to stay under browser storage quota.