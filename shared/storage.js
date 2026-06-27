import { DEFAULT_SETTINGS } from "./defaults.js";

export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

// Serialize writes so concurrent setSettings calls don't each read the same
// stale snapshot and clobber one another (e.g. changing mode + threshold in
// quick succession would otherwise revert one of the two). Each write waits for
// the previous one to commit, then reads fresh.
let _writeChain = Promise.resolve();
export function setSettings(patch) {
  const run = async () => {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ settings: next });
    return next;
  };
  const result = _writeChain.then(run, run); // run regardless of prior outcome
  _writeChain = result.catch(() => {});      // keep the chain alive on failure
  return result;                             // caller still sees real result/errors
}

export async function resetSettings() {
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS } });
  return { ...DEFAULT_SETTINGS };
}

export function onSettingsChanged(handler) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      handler(changes.settings.newValue, changes.settings.oldValue);
    }
  });
}

// --- Score cache (post-hash → { score, category, reason, ts }) -------------

const CACHE_KEY = "scoreCache";

export async function getCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return stored[CACHE_KEY] || {};
}

export async function readCached(hash, ttlHours) {
  const cache = await getCache();
  const entry = cache[hash];
  if (!entry) return null;
  const ageMs = Date.now() - entry.ts;
  if (ageMs > ttlHours * 3600_000) return null;
  return entry;
}

export async function writeCached(hash, value) {
  const cache = await getCache();
  cache[hash] = { ...value, ts: Date.now() };
  // Cap cache at ~2000 entries (LRU by ts)
  const entries = Object.entries(cache);
  if (entries.length > 2000) {
    entries.sort((a, b) => b[1].ts - a[1].ts);
    const trimmed = Object.fromEntries(entries.slice(0, 1500));
    await chrome.storage.local.set({ [CACHE_KEY]: trimmed });
  } else {
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  }
}

export async function clearCache() {
  await chrome.storage.local.remove(CACHE_KEY);
}

// FNV-1a 32-bit hash; sufficient for content-addressing post text + prompt context.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
