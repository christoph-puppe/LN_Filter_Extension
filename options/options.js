import {
  DEFAULT_SETTINGS,
  DEFAULT_PROMPT,
  DEFAULT_INTERESTS,
  DEFAULT_DISLIKES,
  DEFAULT_CATEGORIES,
  MODEL_OPTIONS
} from "../shared/defaults.js";
import { getSettings, setSettings, resetSettings, clearCache } from "../shared/storage.js";

const $ = id => document.getElementById(id);

let saveTimer = null;

function flash(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 1100);
}

async function save(patch, flashId) {
  await setSettings(patch);
  if (flashId) flash(flashId);
}

function debouncedSave(patch, flashId) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(patch, flashId), 280);
}

// ----- model select -----
function populateModelSelect(current) {
  const sel = $("model");
  sel.innerHTML = "";
  for (const opt of MODEL_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.id;
    o.textContent = opt.label;
    if (opt.id === current) o.selected = true;
    sel.appendChild(o);
  }
}

// ----- categories grid -----
function populateCategories(values) {
  const grid = $("cats");
  grid.innerHTML = "";
  const keys = Object.keys(DEFAULT_CATEGORIES);
  for (const key of keys) {
    const v = values[key] ?? DEFAULT_CATEGORIES[key];
    const cat = document.createElement("div");
    cat.className = "cat";
    cat.innerHTML = `
      <div class="cat-head">
        <span class="cat-name">${key}</span>
        <span class="cat-val" data-k="${key}">${v}</span>
      </div>
      <input type="range" min="0" max="100" value="${v}" data-cat="${key}" />
    `;
    grid.appendChild(cat);
  }
  grid.querySelectorAll("input[type=range]").forEach(inp => {
    inp.addEventListener("input", () => {
      grid.querySelector(`.cat-val[data-k="${inp.dataset.cat}"]`).textContent = inp.value;
    });
    inp.addEventListener("change", async () => {
      const cats = {};
      grid.querySelectorAll("input[type=range]").forEach(i => {
        cats[i.dataset.cat] = Number(i.value);
      });
      await save({ categories: cats }, "saved-cats");
    });
  });
}

// ----- prompt placeholder validation -----
const REQUIRED_PLACEHOLDERS = ["{interests}", "{dislikes}", "{categories}", "{author}", "{text}", "{today}"];
function validatePromptPlaceholders() {
  const txt = $("prompt").value;
  const missing = REQUIRED_PLACEHOLDERS.filter(p => !txt.includes(p));
  const warn = $("ph-warn");
  if (missing.length === 0) {
    warn.hidden = true;
  } else {
    warn.hidden = false;
    warn.textContent = `MISSING: ${missing.join(" ")}`;
  }
}

// ----- nav scrollspy -----
function setupNav() {
  const links = document.querySelectorAll(".rail-nav a");
  const sections = Array.from(links).map(a => $(a.getAttribute("href").slice(1)));
  const main = document.querySelector(".main");
  main.addEventListener("scroll", () => {
    const y = main.scrollTop + 100;
    let active = sections[0];
    for (const s of sections) {
      if (s && s.offsetTop <= y) active = s;
    }
    links.forEach(a => a.classList.toggle("active", a.getAttribute("href") === `#${active?.id}`));
  });
}

// ----- bootstrap -----
async function load() {
  const s = await getSettings();

  $("version-pill").textContent = "v" + chrome.runtime.getManifest().version;

  const keyPill = $("key-pill");
  if (s.apiKey) {
    keyPill.textContent = "● Key set";
    keyPill.classList.add("live");
    keyPill.classList.remove("warn");
  } else {
    keyPill.textContent = "○ no key";
    keyPill.classList.add("warn");
    keyPill.classList.remove("live");
  }

  $("api-key").value = s.apiKey || "";
  populateModelSelect(s.model);
  $("interests").value = s.interests || "";
  $("dislikes").value = s.dislikes || "";
  $("prompt").value = s.prompt || DEFAULT_PROMPT;
  validatePromptPlaceholders();

  populateCategories(s.categories || DEFAULT_CATEGORIES);

  $("concurrency").value = s.concurrency;
  $("concurrency-val").textContent = s.concurrency;
  $("thinking").value = s.thinkingLevel;
  $("retries").value = s.retries;
  $("retries-val").textContent = s.retries;
  $("lookahead").value = s.bulkLookahead;
  $("lookahead-val").textContent = s.bulkLookahead;
  $("cache-ttl").value = s.cacheTtlHours;
  $("cache-ttl-val").textContent = s.cacheTtlHours;
  $("threshold-default").value = s.threshold;
  $("threshold-default-val").textContent = s.threshold;
  $("grounding").checked = !!s.groundingEnabled;
}

// ----- wire events -----
$("api-key").addEventListener("input", e => {
  const set = !!e.target.value.trim();
  const keyPill = $("key-pill");
  keyPill.textContent = set ? "● Key set" : "○ no key";
  keyPill.classList.toggle("live", set);
  keyPill.classList.toggle("warn", !set);
  debouncedSave({ apiKey: e.target.value.trim() }, "saved-model");
});

$("toggle-key").addEventListener("click", () => {
  const el = $("api-key");
  el.type = el.type === "password" ? "text" : "password";
});

$("model").addEventListener("change", e => save({ model: e.target.value }, "saved-model"));

$("interests").addEventListener("input", e => debouncedSave({ interests: e.target.value }, "saved-prefs"));
$("dislikes").addEventListener("input", e => debouncedSave({ dislikes: e.target.value }, "saved-prefs"));

$("reset-interests").addEventListener("click", async () => {
  $("interests").value = DEFAULT_INTERESTS;
  await save({ interests: DEFAULT_INTERESTS }, "saved-prefs");
});
$("reset-dislikes").addEventListener("click", async () => {
  $("dislikes").value = DEFAULT_DISLIKES;
  await save({ dislikes: DEFAULT_DISLIKES }, "saved-prefs");
});

$("reset-cats").addEventListener("click", async () => {
  populateCategories(DEFAULT_CATEGORIES);
  await save({ categories: { ...DEFAULT_CATEGORIES } }, "saved-cats");
});

$("prompt").addEventListener("input", e => {
  validatePromptPlaceholders();
  debouncedSave({ prompt: e.target.value }, "saved-prompt");
});
$("reset-prompt").addEventListener("click", async () => {
  $("prompt").value = DEFAULT_PROMPT;
  validatePromptPlaceholders();
  await save({ prompt: DEFAULT_PROMPT }, "saved-prompt");
});

function wireRange(id, key, valId, transform = Number) {
  $(id).addEventListener("input", () => { $(valId).textContent = $(id).value; });
  $(id).addEventListener("change", () => save({ [key]: transform($(id).value) }, "saved-perf"));
}
wireRange("concurrency", "concurrency", "concurrency-val");
wireRange("retries", "retries", "retries-val");
wireRange("lookahead", "bulkLookahead", "lookahead-val");
wireRange("cache-ttl", "cacheTtlHours", "cache-ttl-val");
wireRange("threshold-default", "threshold", "threshold-default-val");
$("thinking").addEventListener("change", e => save({ thinkingLevel: e.target.value }, "saved-perf"));
$("grounding").addEventListener("change", e => save({ groundingEnabled: e.target.checked }, "saved-perf"));

$("clear-cache").addEventListener("click", async () => {
  if (!confirm("Really clear the score cache? All known posts will be re-rated on next visit.")) return;
  await clearCache();
  flash("saved-perf");
});
$("reset-all").addEventListener("click", async () => {
  if (!confirm("Really reset all settings? The API key will also be deleted.")) return;
  await resetSettings();
  await clearCache();
  await load();
  flash("saved-perf");
});

setupNav();
load();
