// Storage shared by index.html and battledex.html.
//
// BattleDex: saved fighters in localStorage, as an array of { id, label, image }
// (no fight data). Last fight: the most recent result in sessionStorage, so the
// BattleDex page can send you back to it. It lasts for the browser tab only.

const DEX_KEY = "battleground.battledex";
const LAST_FIGHT_KEY = "battleground.lastFight";
const PICKS_KEY = "battleground.picks";

function loadDex() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DEX_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((f) => f && f.label && f.image) : [];
  } catch {
    return []; // storage blocked or corrupted: show an empty BattleDex rather than crash
  }
}

// Returns true on success, false if storage is full or unavailable.
function storeDex(fighters) {
  try {
    localStorage.setItem(DEX_KEY, JSON.stringify(fighters));
    return true;
  } catch (err) {
    console.error("Couldn't save the BattleDex:", err);
    return false;
  }
}

function newId() {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// lastFight: { fighterA, fighterB, verdict } exactly as passed to renderResult().
function saveLastFight(lastFight) {
  try {
    sessionStorage.setItem(LAST_FIGHT_KEY, JSON.stringify(lastFight));
  } catch (err) {
    console.error("Couldn't remember the last fight:", err);
  }
}

function loadLastFight() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(LAST_FIGHT_KEY) || "null");
    return parsed && parsed.fighterA && parsed.fighterB && parsed.verdict ? parsed : null;
  } catch {
    return null;
  }
}

// Picks: up to two BattleDex fighters chosen on battledex.html to fight with,
// handed to index.html through sessionStorage as [{ label, image }, ...].
function savePicks(picks) {
  try {
    sessionStorage.setItem(PICKS_KEY, JSON.stringify(picks));
    return true;
  } catch (err) {
    console.error("Couldn't hand over the picked fighters:", err);
    return false;
  }
}

// Reads the picks once and clears them, so a reload doesn't pick them again.
function takePicks() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PICKS_KEY) || "[]");
    sessionStorage.removeItem(PICKS_KEY);
    return Array.isArray(parsed) ? parsed.filter((f) => f && f.label && f.image).slice(0, 2) : [];
  } catch {
    return [];
  }
}
