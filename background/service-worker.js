import { getSettings, readCached, writeCached, hashString, clearCache } from "../shared/storage.js";
import { scorePost, runPool, buildPrompt } from "../shared/gemini.js";

// Per-tab state. Each tab gets its own queue + cancel flag so users can have
// multiple LinkedIn tabs open without crosstalk.
const tabs = new Map(); // tabId -> { queue: Map<postId,{post,resolve,reject}>, cancelRef, running }

function ensureTab(tabId) {
  if (!tabs.has(tabId)) {
    tabs.set(tabId, {
      pending: new Map(),
      cancelRef: { cancelled: false },
      running: false
    });
  }
  return tabs.get(tabId);
}

// All three surface in chrome://extensions → LN Filter → "Inspect views:
// service worker". Keep them prefixed so they're easy to filter.
function log(...args)  { console.log("[LN-Filter SW]", ...args); }
function warn(...args) { console.warn("[LN-Filter SW]", ...args); }
function logErr(...args) { console.error("[LN-Filter SW]", ...args); }

const short = s => (s || "").toString().replace(/\s+/g, " ").trim().slice(0, 40);

async function processBatch(tabId) {
  const state = ensureTab(tabId);
  if (state.running) return;
  if (state.pending.size === 0) return;

  state.running = true;
  state.cancelRef.cancelled = false;

  try {
    const settings = await getSettings();
    if (!settings.apiKey) {
      warn(`no Gemini API key set — ${state.pending.size} post(s) cannot be scored. Open Options and paste your key.`);
      // Reject all pending — UI shows a "set API key" hint.
      for (const { post } of state.pending.values()) {
        chrome.tabs.sendMessage(tabId, {
          type: "SCORE_ERROR",
          postId: post.id,
          error: "No Gemini API key configured (open Options page)"
        }).catch(() => {});
      }
      state.pending.clear();
      return;
    }

    // Snapshot current pending; new arrivals during the run start a new batch on next drain.
    const batch = Array.from(state.pending.values());
    state.pending.clear();

    log(`▶ scoring ${batch.length} post(s) on tab ${tabId} — model=${settings.model} grounding=${!!settings.groundingEnabled} concurrency=${settings.concurrency || 4} thinking=${settings.thinkingLevel}`);

    const tasks = batch.map(({ post }) => async () => {
      const promptStr = buildPrompt(settings.prompt, settings, post);
      // Cache key includes grounding flag — grounded vs ungrounded produce
      // semantically different scores even for the same prompt.
      const cacheKey = hashString(
        `${settings.model}|g${settings.groundingEnabled ? 1 : 0}|${promptStr}`
      );

      // Cache check — saves API calls on re-renders of the same post.
      const cached = await readCached(cacheKey, settings.cacheTtlHours);
      if (cached) {
        log(`  ⓒ cache  ${cached.score}  [${cached.category}]  ${short(post.author)}`);
        chrome.tabs.sendMessage(tabId, {
          type: "SCORE_RESULT",
          postId: post.id,
          score: cached.score,
          category: cached.category,
          reason: cached.reason,
          cached: true
        }).catch(() => {});
        return { cached: true };
      }

      try {
        const result = await scorePost({
          apiKey: settings.apiKey,
          model: settings.model,
          prompt: promptStr,
          thinkingLevel: settings.thinkingLevel,
          retries: settings.retries,
          grounding: !!settings.groundingEnabled
        });
        log(`  ✓ score  ${result.score}  [${result.category}]  ${short(post.author)}`);
        await writeCached(cacheKey, {
          score: result.score,
          category: result.category,
          reason: result.reason
        });
        chrome.tabs.sendMessage(tabId, {
          type: "SCORE_RESULT",
          postId: post.id,
          score: result.score,
          category: result.category,
          reason: result.reason,
          cached: false
        }).catch(() => {});
        return { ok: true };
      } catch (e) {
        const emsg = e.message || String(e);
        logErr(`  ✗ FAIL   ${short(post.author)} :: ${emsg}`);
        chrome.tabs.sendMessage(tabId, {
          type: "SCORE_ERROR",
          postId: post.id,
          error: emsg
        }).catch(() => {});
        return { error: emsg };
      }
    });

    let done = 0;
    const results = await runPool(
      tasks,
      Math.max(1, settings.concurrency || 4),
      d => {
        done = d;
        chrome.tabs.sendMessage(tabId, {
          type: "PROGRESS",
          done,
          total: tasks.length
        }).catch(() => {});
      },
      state.cancelRef
    );

    // Tally for the batch summary line.
    let scored = 0, cachedN = 0, failed = 0;
    for (const r of results) {
      const v = r && r.value;
      if (r && r.error) failed++;
      else if (v && v.error) failed++;
      else if (v && v.cached) cachedN++;
      else if (v && v.ok) scored++;
    }
    const summary = `■ batch done tab ${tabId}: ${scored} scored · ${cachedN} cached · ${failed} failed (${done}/${tasks.length})`;
    if (failed > 0) warn(summary); else log(summary);
  } finally {
    state.running = false;
    // Drain any posts queued during the run.
    if (state.pending.size > 0) {
      // Fire-and-forget; the next call enters above.
      processBatch(tabId);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === "ENQUEUE_SCORE") {
    if (tabId == null) return;
    const state = ensureTab(tabId);
    let added = 0;
    for (const post of msg.posts) {
      if (!state.pending.has(post.id)) {
        state.pending.set(post.id, { post });
        added++;
      }
    }
    log(`↧ enqueue tab ${tabId}: +${added} new (${msg.posts.length} received, ${state.pending.size} pending)`);
    processBatch(tabId);
    sendResponse({ queued: msg.posts.length, pending: state.pending.size });
    return true;
  }

  if (msg.type === "CANCEL") {
    if (tabId == null) return;
    const state = ensureTab(tabId);
    state.cancelRef.cancelled = true;
    state.pending.clear();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "CLEAR_CACHE") {
    clearCache().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  const state = tabs.get(tabId);
  if (state) {
    state.cancelRef.cancelled = true;
    tabs.delete(tabId);
  }
});

log(`service worker booted (v${chrome.runtime.getManifest().version})`);
getSettings().then(s => {
  log(`config: model=${s.model} · key=${s.apiKey ? "set (…" + s.apiKey.slice(-4) + ")" : "MISSING"} · grounding=${!!s.groundingEnabled} · mode=${s.mode} · threshold=${s.threshold}`);
  if (!s.apiKey) warn("No API key configured — scoring will not run until you set one in Options.");
}).catch(e => logErr("could not read settings on boot:", e.message));
