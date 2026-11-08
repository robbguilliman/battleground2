// Stage 3: the Fight button calls /api/fight for the winner, reasoning and one
// image per fighter. A side whose art failed shows a placeholder and a note.
// Stage 4: fighters can be saved to the BattleDex (localStorage); the BattleDex
// itself is its own page, battledex.html. Storage helpers come from dex-store.js.
// Stage 6: the "Battleground Arcade" look (style.css); this file fills in the
// arcade extras: loading names, HP bars, winner/loser cards, the 429 countdown.

const views = {
  form: document.getElementById("view-form"),
  loading: document.getElementById("view-loading"),
  result: document.getElementById("view-result"),
  error: document.getElementById("view-error"),
};

const form = document.getElementById("fight-form");
const inputA = document.getElementById("fighter-a");
const inputB = document.getElementById("fighter-b");

const MAX_FIGHTER_LENGTH = 50; // also the inputs' maxlength, and enforced by api/fight.js
const FIGHT_TIMEOUT_MS = 120_000; // never leave the loading view up forever (matches maxDuration)

// Show exactly one view; every other view gets `hidden`.
function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }
  if (name === "loading") startLoadingMessages();
  else stopLoadingMessages();
  stopCountdown(); // showError() restarts it for a rate limit
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Rotating loading messages: on-theme quips that cycle while the fight loads.
// Screen readers get one steady message instead (the quips are aria-hidden).
// ---------------------------------------------------------------------------
const LOADING_MESSAGES = [
  "Sharpening claws…",
  "Consulting the ancient scrolls…",
  "Polishing the championship belt…",
  "Taping up the gloves…",
  "Bribing the referee…",
  "Sweeping the arena floor…",
  "Warming up the crowd…",
  "Checking the rulebook (there are no rules)…",
  "Mixing the pixel paint…",
  "Measuring the tale of the tape…",
  "Flexing in the mirror…",
  "Taking bets from the cheap seats…",
  "Oiling the armor…",
  "Feeding the arena mascot…",
  "Sketching the battle portraits…",
  "Tallying the scorecards…",
];
const LOADING_INTERVAL_MS = 2200;
const loadingText = document.getElementById("loading-text");

// The segmented "power bar" on the loading view: 20 cells lighting up in a wave.
document.getElementById("segbar").append(
  ...Array.from({ length: 20 }, (_, i) => {
    const seg = document.createElement("span");
    seg.style.animationDelay = `${(i * 0.1).toFixed(1)}s`;
    return seg;
  }),
);
let loadingTimer = null;
let loadingQueue = [];

function nextLoadingMessage() {
  // Shuffled deck: every quip shows once before any repeats, never twice in a row.
  if (!loadingQueue.length) {
    const last = loadingText.textContent;
    loadingQueue = [...LOADING_MESSAGES].sort(() => Math.random() - 0.5);
    if (loadingQueue[0] === last) loadingQueue.push(loadingQueue.shift());
  }
  return loadingQueue.shift();
}

function showLoadingMessage() {
  loadingText.classList.add("is-swapping");
  setTimeout(() => {
    loadingText.textContent = nextLoadingMessage();
    loadingText.classList.remove("is-swapping");
  }, 150);
}

function startLoadingMessages() {
  stopLoadingMessages();
  loadingText.textContent = nextLoadingMessage();
  loadingTimer = setInterval(showLoadingMessage, LOADING_INTERVAL_MS);
}

function stopLoadingMessages() {
  clearInterval(loadingTimer);
  loadingTimer = null;
}

function showError(message, title = "Chaos in the arena!", retryAfterSec = 0) {
  document.getElementById("error-title").textContent = title;
  document.getElementById("error-message").textContent = message;
  showView("error");
  if (retryAfterSec > 0) startCountdown(retryAfterSec);
}

// ---------------------------------------------------------------------------
// Rate-limit countdown on the error view ("CONTINUE? ARENA REOPENS IN 42").
// The Try again button stays locked until the arena reopens.
// ---------------------------------------------------------------------------
const PIP_COUNT = 6;
const countdownEl = document.getElementById("countdown");
const countdownSecs = document.getElementById("countdown-secs");
const countdownPips = document.getElementById("countdown-pips");
const retryBtn = document.getElementById("error-retry");
let countdownTimer = null;

countdownPips.append(...Array.from({ length: PIP_COUNT }, () => document.createElement("span")));

function renderCountdown(secs, total) {
  countdownSecs.textContent = String(secs).padStart(2, "0");
  countdownSecs.classList.remove("is-ticking");
  void countdownSecs.offsetWidth; // restart the tick animation
  countdownSecs.classList.add("is-ticking");
  const lit = Math.ceil((secs / total) * PIP_COUNT);
  [...countdownPips.children].forEach((pip, i) => pip.classList.toggle("is-lit", i < lit));
  countdownPips.classList.toggle("is-low", lit <= 2);
  const waiting = secs > 0;
  retryBtn.disabled = waiting;
  retryBtn.textContent = waiting ? "Hold tight…" : "Try again";
}

function startCountdown(total) {
  stopCountdown();
  const endsAt = Date.now() + total * 1000;
  countdownEl.hidden = false;
  const tick = () => {
    const secs = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    renderCountdown(secs, total);
    if (secs === 0) stopCountdown({ keepVisible: true });
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function stopCountdown({ keepVisible = false } = {}) {
  clearInterval(countdownTimer);
  countdownTimer = null;
  if (!keepVisible) countdownEl.hidden = true;
  retryBtn.disabled = false;
  retryBtn.textContent = "Try again";
}

// Placeholder art: a solid-color SVG with the fighter's initial, as a data URI.
function placeholderImage(label, color) {
  const initial = (label.trim()[0] || "?").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
    <rect width="200" height="200" fill="${color}"/>
    <text x="100" y="125" font-family="sans-serif" font-size="80" font-weight="700"
      fill="#fff" text-anchor="middle">${initial.replace(/[<>&"']/g, "")}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Calls the fight API. Resolves to { winner: "A" | "B", reasoning, images }, or throws
// a FightError whose title/message are ready to show in the error view.
class FightError extends Error {
  constructor(title, message, retryAfterSec = 0) {
    super(message);
    this.title = title;
    this.retryAfterSec = retryAfterSec; // > 0 only for our own rate limit
  }
}

async function requestFight(fighterA, fighterB, reuseArt = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIGHT_TIMEOUT_MS);

  let response;
  try {
    response = await fetch("/api/fight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fighterA, fighterB, reuseArt }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new FightError("Time's up!", "The judges deliberated so long the crowd went home. Ring the bell and try again!");
    }
    throw new FightError("Lost the signal!", "We can't reach the arena. Check your internet connection, then step back into the ring.");
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => null);

  if (response.ok && (data?.winner === "A" || data?.winner === "B")) return data;

  const message = data?.error?.message;
  if (response.status === 429) {
    const retryAfter = Math.min(Number(response.headers.get("Retry-After")) || 60, 120);
    throw new FightError("Whoa, easy, champ!", message || "That's a lot of fights in a row. The arena needs a minute to breathe, then you're back on.", retryAfter);
  }
  if (response.status === 400) {
    throw new FightError("Hold it right there!", message || "Those fighters failed the weigh-in. Check the names and try again.");
  }
  throw new FightError("No decision!", message || "The judges' table is in chaos. Ring the bell and try again!");
}

// The fighters on screen, for the save buttons: { a: { label, image }, b: ... },
// image null if that side has no art.
let lastFight = null;

function renderResult(fighterA, fighterB, verdict) {
  const winnerSide = verdict.winner === "A" ? "a" : "b";
  document.getElementById("result-winner").textContent = winnerSide === "a" ? fighterA : fighterB;
  document.getElementById("result-reasoning").textContent = verdict.reasoning;

  const sides = [
    { label: fighterA, art: verdict.images?.A, key: "a", color: "#1d4f9e" },
    { label: fighterB, art: verdict.images?.B, key: "b", color: "#9e2433" },
  ];
  for (const side of sides) {
    const won = side.key === winnerSide;
    const img = document.getElementById(`image-${side.key}`);
    img.src = side.art?.src || placeholderImage(side.label, side.color);
    img.alt = side.label;
    document.getElementById(`label-${side.key}`).textContent = side.label;
    const card = document.getElementById(`card-${side.key}`);
    card.classList.toggle("is-winner", won);
    card.classList.toggle("is-loser", !won);

    // Fighting-game HP bars across the top: the loser is drained to 0 HP.
    const hp = document.getElementById(`hp-${side.key}`);
    hp.classList.toggle("is-winner", won);
    hp.classList.toggle("is-loser", !won);
    const player = side.key === "a" ? "P1" : "P2";
    document.getElementById(`hp-name-${side.key}`).textContent =
      side.key === "a" ? `${player} · ${side.label}` : `${side.label} · ${player}`;
    document.getElementById(`hp-status-${side.key}`).textContent = won ? "Wins" : "0 HP";

    // Image failures are per side: moderation-blocked and generic failures get
    // different messages (and styling); the verdict still shows either way.
    const note = document.getElementById(`art-error-${side.key}`);
    const artError = side.art?.src ? null : side.art?.error || { type: "image_failed" };
    note.hidden = !artError;
    note.classList.toggle("is-blocked", artError?.type === "image_blocked");
    note.textContent = !artError
      ? ""
      : artError.type === "image_blocked"
        ? artError.message || "The arena officials stopped this portrait at the gates. Try a different fighter!"
        : artError.message || "Our artist dropped the brush on this one.";
  }

  lastFight = {
    a: { label: fighterA, image: verdict.images?.A?.src || null },
    b: { label: fighterB, image: verdict.images?.B?.src || null },
  };
  // Remember the fight for this tab so battledex.html can link back to it.
  saveLastFight({ fighterA, fighterB, verdict });
  resetSaveButtons();
  showView("result");
}

// ---------------------------------------------------------------------------
// Saving fighters to the BattleDex
// ---------------------------------------------------------------------------
const saveStatus = document.getElementById("save-status");

// Already in the BattleDex? The BattleDex holds compressed copies, so match on
// the original's fingerprint (sourceKey), or on the image itself for fighters
// picked from the BattleDex, whose art already is the saved copy.
function isSaved(image, dex) {
  if (!image) return false;
  const key = imageKey(image);
  return dex.some((f) => f.image === image || f.sourceKey === key);
}

// The count badge on the form's BattleDex button.
function updateDexBadge() {
  document.getElementById("dex-count-badge").textContent = String(loadDex().length);
}

function resetSaveButtons() {
  saveStatus.textContent = "";
  const dex = loadDex();
  for (const key of ["a", "b"]) {
    const btn = document.getElementById(`save-${key}`);
    const image = lastFight?.[key]?.image;
    const saved = isSaved(image, dex);
    btn.disabled = !image || saved;
    btn.textContent = !image ? "No art to save" : saved ? "Saved ✓" : "Save to BattleDex";
  }
}

async function saveFighter(key) {
  const fighter = lastFight?.[key];
  const btn = document.getElementById(`save-${key}`);
  if (!fighter?.image) return;

  btn.disabled = true;
  btn.textContent = "Saving…";

  // Stage 5: save a small compressed copy, not the full-size original.
  let image;
  try {
    image = await compressImage(fighter.image);
  } catch (err) {
    console.error("Compression failed, saving the original:", err);
    image = fighter.image;
  }

  const dex = loadDex();
  dex.push({ id: newId(), label: fighter.label, image, sourceKey: imageKey(fighter.image) });
  if (storeDex(dex)) {
    btn.textContent = "Saved ✓";
    saveStatus.textContent = `${fighter.label} has joined your BattleDex!`;
    updateDexBadge();
  } else {
    btn.disabled = false;
    btn.textContent = "Save to BattleDex";
    saveStatus.textContent =
      "Your BattleDex is full to the rafters! Retire a few fighters to make room, then try again.";
  }
}

document.querySelectorAll("[data-save]").forEach((btn) => {
  btn.addEventListener("click", () => saveFighter(btn.dataset.save));
});

// ---------------------------------------------------------------------------
// Fighters picked on battledex.html: prefill the form and reuse their saved art
// ---------------------------------------------------------------------------
const picks = { a: null, b: null }; // { label, image } per side, or null

function setPick(key, pick) {
  picks[key] = pick;
  document.getElementById(`picked-${key}`).hidden = !pick;
  const img = document.getElementById(`picked-img-${key}`);
  if (pick) img.src = pick.image;
  else img.removeAttribute("src");
  if (pick) document.getElementById(`fighter-${key}`).value = pick.label;
  updateCount(key);
}

// "14/50" under each input.
function updateCount(key) {
  const length = document.getElementById(`fighter-${key}`).value.length;
  const count = document.getElementById(`count-${key}`);
  count.textContent = `${length}/${MAX_FIGHTER_LENGTH}`;
  count.classList.toggle("is-full", length >= MAX_FIGHTER_LENGTH);
}

// Editing a picked fighter's name makes it a new fighter, so its art is dropped.
for (const key of ["a", "b"]) {
  document.getElementById(`fighter-${key}`).addEventListener("input", (event) => {
    if (picks[key] && event.target.value.trim() !== picks[key].label) setPick(key, null);
    updateCount(key);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fighterA = inputA.value.trim();
  const fighterB = inputB.value.trim();

  if (!fighterA || !fighterB) {
    showError("We need a challenger in both corners before the bell can ring!", "Empty corner!");
    return;
  }
  // maxlength stops typing past the limit, but not every path into the form
  // does (e.g. a long name picked from the BattleDex).
  if (fighterA.length > MAX_FIGHTER_LENGTH || fighterB.length > MAX_FIGHTER_LENGTH) {
    showError(`Whoa, that's a mouthful! The ring announcer can't shout a name that long. Keep each fighter to ${MAX_FIGHTER_LENGTH} characters or fewer.`, "Name too long!");
    return;
  }

  const pickA = picks.a?.label === fighterA ? picks.a : null;
  const pickB = picks.b?.label === fighterB ? picks.b : null;
  const reuseArt = [pickA && "A", pickB && "B"].filter(Boolean);

  document.getElementById("loading-name-a").textContent = fighterA;
  document.getElementById("loading-name-b").textContent = fighterB;
  showView("loading");
  try {
    const verdict = await requestFight(fighterA, fighterB, reuseArt);
    // Picked fighters keep their saved BattleDex art instead of new art.
    if (pickA) verdict.images = { ...verdict.images, A: { src: pickA.image } };
    if (pickB) verdict.images = { ...verdict.images, B: { src: pickB.image } };
    renderResult(fighterA, fighterB, verdict);
  } catch (err) {
    if (err instanceof FightError) showError(err.message, err.title, err.retryAfterSec);
    else {
      console.error(err);
      showError("Something went haywire behind the scenes. Dust yourself off and try again!");
    }
  }
});

document.querySelectorAll('[data-action="new-fight"]').forEach((btn) => {
  btn.addEventListener("click", () => {
    updateDexBadge();
    showView("form");
    inputA.focus();
  });
});

updateDexBadge();
updateCount("a");
updateCount("b");
window.addEventListener("pageshow", updateDexBadge); // back from battledex.html

// battledex.html links to index.html#last-fight to reopen this tab's last fight,
// and to index.html#picked after picking fighters to fight with.
const restored = location.hash === "#last-fight" ? loadLastFight() : null;
if (restored) {
  renderResult(restored.fighterA, restored.fighterB, restored.verdict);
} else {
  if (location.hash === "#picked") {
    const [first, second] = takePicks();
    if (first) setPick("a", first);
    if (second) setPick("b", second);
    (second || !first ? document.querySelector('#fight-form [type="submit"]') : inputB).focus();
  }
  showView("form");
}
if (location.hash) history.replaceState(null, "", location.pathname); // a reload starts fresh
