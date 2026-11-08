// Stage 3: the Fight button calls /api/fight for the winner, reasoning and one
// image per fighter. A side whose art failed shows a placeholder and a note.
// Stage 4: fighters can be saved to the BattleDex (localStorage); the BattleDex
// itself is its own page, battledex.html. Storage helpers come from dex-store.js.

const views = {
  form: document.getElementById("view-form"),
  loading: document.getElementById("view-loading"),
  result: document.getElementById("view-result"),
  error: document.getElementById("view-error"),
};

const form = document.getElementById("fight-form");
const inputA = document.getElementById("fighter-a");
const inputB = document.getElementById("fighter-b");

const FIGHT_TIMEOUT_MS = 120_000; // never leave the loading view up forever (matches maxDuration)

// Show exactly one view; every other view gets `hidden`.
function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }
}

function showError(message, title = "Something went wrong") {
  document.getElementById("error-title").textContent = title;
  document.getElementById("error-message").textContent = message;
  showView("error");
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
  constructor(title, message) {
    super(message);
    this.title = title;
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
      throw new FightError("The judge timed out", "The verdict took too long. Please try again.");
    }
    throw new FightError("You're offline", "Couldn't reach the arena. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => null);

  if (response.ok && (data?.winner === "A" || data?.winner === "B")) return data;

  const message = data?.error?.message;
  if (response.status === 429) {
    throw new FightError("Too many fights", message || "You've hit the fight limit. Wait a minute and try again.");
  }
  if (response.status === 400) {
    throw new FightError("Check your fighters", message || "Those fighters couldn't enter the ring.");
  }
  throw new FightError("The judge couldn't decide", message || "The verdict failed. Please try again.");
}

// The fighters on screen, for the save buttons: { a: { label, image }, b: ... },
// image null if that side has no art.
let lastFight = null;

function renderResult(fighterA, fighterB, verdict) {
  const winnerSide = verdict.winner === "A" ? "a" : "b";
  document.getElementById("result-winner").textContent = winnerSide === "a" ? fighterA : fighterB;
  document.getElementById("result-reasoning").textContent = verdict.reasoning;

  const sides = [
    { label: fighterA, art: verdict.images?.A, key: "a", color: "#3a6ea5" },
    { label: fighterB, art: verdict.images?.B, key: "b", color: "#a53a3a" },
  ];
  for (const side of sides) {
    const img = document.getElementById(`image-${side.key}`);
    img.src = side.art?.src || placeholderImage(side.label, side.color);
    img.alt = side.label;
    document.getElementById(`label-${side.key}`).textContent = side.label;
    document
      .getElementById(`card-${side.key}`)
      .classList.toggle("is-winner", side.key === winnerSide);

    // Image failures are per side: moderation-blocked and generic failures get
    // different messages (and styling); the verdict still shows either way.
    const note = document.getElementById(`art-error-${side.key}`);
    const artError = side.art?.src ? null : side.art?.error || { type: "image_failed" };
    note.hidden = !artError;
    note.classList.toggle("is-blocked", artError?.type === "image_blocked");
    note.textContent = !artError
      ? ""
      : artError.type === "image_blocked"
        ? artError.message || "Blocked by the image safety filter, so this fighter couldn't be drawn."
        : artError.message || "The artist couldn't draw this fighter.";
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

function resetSaveButtons() {
  saveStatus.textContent = "";
  const savedImages = new Set(loadDex().map((f) => f.image));
  for (const key of ["a", "b"]) {
    const btn = document.getElementById(`save-${key}`);
    const image = lastFight?.[key]?.image;
    // Already in the BattleDex (e.g. after coming back from battledex.html)?
    const saved = Boolean(image) && savedImages.has(image);
    btn.disabled = !image || saved;
    btn.textContent = !image ? "No art to save" : saved ? "Saved ✓" : "Save to BattleDex";
  }
}

function saveFighter(key) {
  const fighter = lastFight?.[key];
  const btn = document.getElementById(`save-${key}`);
  if (!fighter?.image) return;

  const dex = loadDex();
  dex.push({ id: newId(), label: fighter.label, image: fighter.image });
  if (storeDex(dex)) {
    btn.disabled = true;
    btn.textContent = "Saved ✓";
    saveStatus.textContent = `${fighter.label} was added to your BattleDex.`;
  } else {
    saveStatus.textContent =
      "Your BattleDex is full. Remove some fighters to make room, then try again.";
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
}

// Editing a picked fighter's name makes it a new fighter, so its art is dropped.
for (const key of ["a", "b"]) {
  document.getElementById(`fighter-${key}`).addEventListener("input", (event) => {
    if (picks[key] && event.target.value.trim() !== picks[key].label) setPick(key, null);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const fighterA = inputA.value.trim();
  const fighterB = inputB.value.trim();

  if (!fighterA || !fighterB) {
    showError("Both fighters need a name before they can fight.", "Check your fighters");
    return;
  }

  const pickA = picks.a?.label === fighterA ? picks.a : null;
  const pickB = picks.b?.label === fighterB ? picks.b : null;
  const reuseArt = [pickA && "A", pickB && "B"].filter(Boolean);

  showView("loading");
  try {
    const verdict = await requestFight(fighterA, fighterB, reuseArt);
    // Picked fighters keep their saved BattleDex art instead of new art.
    if (pickA) verdict.images = { ...verdict.images, A: { src: pickA.image } };
    if (pickB) verdict.images = { ...verdict.images, B: { src: pickB.image } };
    renderResult(fighterA, fighterB, verdict);
  } catch (err) {
    if (err instanceof FightError) showError(err.message, err.title);
    else {
      console.error(err);
      showError("Something unexpected happened. Please try again.");
    }
  }
});

document.querySelectorAll('[data-action="new-fight"]').forEach((btn) => {
  btn.addEventListener("click", () => {
    showView("form");
    inputA.focus();
  });
});

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
