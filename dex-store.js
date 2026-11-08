// Storage shared by index.html and battledex.html.
//
// BattleDex: saved fighters in localStorage, as an array of
// { id, label, image, sourceKey } (image is a compressed copy; see below)
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

// ---------------------------------------------------------------------------
// Image compression (Stage 5): fighters are saved as small WebP/JPEG data URIs
// so the BattleDex stays well under the ~5 MB localStorage quota.
// ---------------------------------------------------------------------------
const DEX_IMAGE_SIZE = 512; // px, longest side: 2x the biggest card, still crisp
const DEX_IMAGE_QUALITY = 0.8;
const DEX_COMPRESS_ABOVE = 120_000; // characters; saved images bigger than this get compressed

/**
 * Draws a data URI onto an off-screen canvas at most DEX_IMAGE_SIZE px wide/tall
 * and re-exports it as WebP (or JPEG where the browser can't encode WebP).
 * Resolves to whichever is smaller, the compressed or the original.
 */
function compressImage(src, { maxSize = DEX_IMAGE_SIZE, quality = DEX_IMAGE_QUALITY } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        let out = canvas.toDataURL("image/webp", quality);
        // Browsers that can't encode WebP silently return PNG; use JPEG instead.
        if (!out.startsWith("data:image/webp")) out = canvas.toDataURL("image/jpeg", quality);
        resolve(out.length < src.length ? out : src);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("Couldn't load the image to compress it."));
    img.src = src;
  });
}

// Short fingerprint of an image's original data URI (FNV-1a), stored as
// `sourceKey` so the fight page can tell a fighter is already saved even though
// the BattleDex holds a compressed copy.
function imageKey(dataUri) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < dataUri.length; i++) {
    hash ^= dataUri.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}-${dataUri.length}`;
}
