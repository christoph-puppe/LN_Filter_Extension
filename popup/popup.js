import { getSettings, setSettings } from "../shared/storage.js";

const $ = id => document.getElementById(id);

function setActive(mode) {
  document.querySelectorAll("#seg-mode button").forEach(b => {
    b.classList.toggle("on", b.dataset.mode === mode);
  });
}

async function refresh() {
  const s = await getSettings();
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
  setActive(s.mode);
  $("thr").value = s.threshold;
  $("thr-val").textContent = s.threshold;
  $("sort").checked = s.sortByScore !== false;
  $("overlay").checked = s.overlayEnabled !== false;

  // API-Key alert
  const alert = $("key-alert");
  if (!s.apiKey) {
    alert.className = "alert warn";
    alert.textContent = "No API key — open Options and add your Gemini key.";
  } else {
    alert.className = "alert ok";
    alert.textContent = `API key set · Model ${s.model}`;
  }

  refreshTabStats();
}

async function refreshTabStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.startsWith("https://www.linkedin.com")) {
      $("stat-rated").textContent = "—";
      $("stat-pending").textContent = "—";
      return;
    }
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATS" }).catch(() => null);
    if (resp) {
      $("stat-rated").textContent = resp.rated;
      $("stat-pending").textContent = resp.pending;
    } else {
      $("stat-rated").textContent = "—";
      $("stat-pending").textContent = "—";
    }
  } catch {
    $("stat-rated").textContent = "—";
    $("stat-pending").textContent = "—";
  }
}

document.querySelectorAll("#seg-mode button").forEach(btn => {
  btn.addEventListener("click", async () => {
    await setSettings({ mode: btn.dataset.mode });
    setActive(btn.dataset.mode);
  });
});

$("thr").addEventListener("input", () => {
  $("thr-val").textContent = $("thr").value;
});
$("thr").addEventListener("change", async () => {
  await setSettings({ threshold: Number($("thr").value) });
});

$("sort").addEventListener("change", async e => {
  await setSettings({ sortByScore: e.target.checked });
});
$("overlay").addEventListener("change", async e => {
  await setSettings({ overlayEnabled: e.target.checked });
});

$("btn-rerate").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
  await chrome.tabs.sendMessage(tab.id, { type: "RERATE_ALL" }).catch(() => {});
  setTimeout(refreshTabStats, 500);
});

$("btn-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

refresh();
setInterval(refreshTabStats, 1500);
