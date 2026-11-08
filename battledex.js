// BattleDex page: shows saved fighters as character-select cards (art on top,
// name plate below). The card itself isn't clickable; its controls are a "Pick"
// toggle and "remove". Picking one or two fighters and pressing "Fight with
// picked" sends them to index.html. Storage helpers come from dex-store.js.

const dexGrid = document.getElementById("dex-grid");
const MAX_PICKS = 2;
let picked = []; // ids of picked fighters, in the order they were picked

// The sticky bar at the bottom: P1 [thumb] name  VS  P2 [thumb] name  [Fight with picked]
function updatePickBar(dex) {
  const fighters = picked.map((id) => dex.find((f) => f.id === id)).filter(Boolean);
  document.getElementById("dex-pick-bar").hidden = dex.length === 0;
  document.getElementById("dex-fight").disabled = fighters.length === 0;

  [1, 2].forEach((slot) => {
    const fighter = fighters[slot - 1];
    const thumb = document.getElementById(`pick-thumb-${slot}`);
    const name = document.getElementById(`pick-name-${slot}`);
    thumb.hidden = !fighter;
    document.getElementById(`pick-empty-${slot}`).hidden = Boolean(fighter);
    if (fighter) thumb.src = fighter.image;
    else thumb.removeAttribute("src");
    name.textContent = fighter ? fighter.label : slot === 1 ? "—" : "Pick an opponent";
    name.classList.toggle("is-empty", !fighter);
  });

  document.getElementById("dex-pick-status").textContent =
    fighters.length === 0
      ? `Picked 0 of ${MAX_PICKS}`
      : fighters.length === 1
        ? `Picked: ${fighters[0].label}. Pick an opponent, or type one in on the next screen.`
        : `Picked: ${fighters[0].label} vs ${fighters[1].label}`;
}

function togglePick(id) {
  if (picked.includes(id)) picked = picked.filter((p) => p !== id);
  else if (picked.length < MAX_PICKS) picked.push(id);
  renderDex();
}

function renderDex() {
  const dex = loadDex();
  picked = picked.filter((id) => dex.some((f) => f.id === id)); // drop picks removed elsewhere
  dexGrid.replaceChildren(
    ...dex.map((fighter) => {
      const li = document.createElement("li");
      li.className = "dex-card";

      const img = document.createElement("img");
      img.src = fighter.image;
      img.alt = fighter.label;
      img.loading = "lazy";

      const name = document.createElement("p");
      name.className = "dex-card-name";
      name.textContent = fighter.label;

      const order = picked.indexOf(fighter.id) + 1; // 1 = P1, 2 = P2, 0 = not picked
      const isPicked = order > 0;
      li.classList.toggle(`is-picked-${order}`, isPicked);
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "dex-card-pick";
      pick.setAttribute("aria-pressed", String(isPicked));
      pick.textContent = isPicked ? `Picked ${order}` : "Pick";
      pick.disabled = !isPicked && picked.length >= MAX_PICKS;
      pick.setAttribute("aria-label", `${isPicked ? "Unpick" : "Pick"} ${fighter.label}`);
      pick.addEventListener("click", () => togglePick(fighter.id));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "dex-card-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${fighter.label} from BattleDex`);
      remove.addEventListener("click", () => {
        picked = picked.filter((p) => p !== fighter.id);
        storeDex(loadDex().filter((f) => f.id !== fighter.id));
        renderDex();
      });

      li.append(img, name, pick, remove);
      if (isPicked) {
        const tag = document.createElement("span");
        tag.className = "dex-card-tag";
        tag.setAttribute("aria-hidden", "true");
        tag.textContent = `P${order}`;
        li.append(tag);
      }
      return li;
    }),
  );

  const empty = dex.length === 0;
  document.getElementById("dex-count").textContent = dex.length === 1 ? "1 fighter" : `${dex.length} fighters`;
  document.getElementById("dex-subtitle").textContent = empty
    ? "No challengers yet"
    : "Select your fighters — pick one or two";
  dexGrid.hidden = empty;
  document.getElementById("dex-empty").hidden = !empty;
  document.getElementById("dex-clear").hidden = empty;
  updatePickBar(dex);
}

document.getElementById("dex-clear").addEventListener("click", () => {
  if (confirm("Send every fighter in your BattleDex home for good? There's no rematch for this one.")) {
    picked = [];
    storeDex([]);
    renderDex();
  }
});

document.getElementById("dex-fight").addEventListener("click", () => {
  const dex = loadDex();
  const picks = picked
    .map((id) => dex.find((f) => f.id === id))
    .filter(Boolean)
    .map(({ label, image }) => ({ label, image }));
  if (picks.length && savePicks(picks)) location.href = "index.html#picked";
});

// Fighters saved before Stage 5 were stored full size. Compress them once, in
// place, to free up storage. Keeps their fingerprint so "Saved ✓" still works.
async function shrinkOldFighters() {
  const big = loadDex().filter((f) => f.image.length > DEX_COMPRESS_ABOVE);
  if (!big.length) return;
  const shrunk = new Map();
  for (const f of big) {
    try {
      shrunk.set(f.id, { image: await compressImage(f.image), sourceKey: f.sourceKey || imageKey(f.image) });
    } catch (err) {
      console.error(`Couldn't compress ${f.label}:`, err);
    }
  }
  // Re-read so a remove done meanwhile isn't undone.
  const dex = loadDex().map((f) => (shrunk.has(f.id) ? { ...f, ...shrunk.get(f.id) } : f));
  if (storeDex(dex)) renderDex();
}

// Only offer "Back to last fight" when this tab has had a fight.
document.getElementById("dex-back").hidden = !loadLastFight();

// Re-render when you come back with the browser's back button (page cache) or
// when another tab changes the BattleDex.
window.addEventListener("pageshow", renderDex);
window.addEventListener("storage", (event) => {
  if (event.key === DEX_KEY) renderDex();
});

renderDex();
shrinkOldFighters();
