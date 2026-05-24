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

function log(...args) {
  // Easy to find in chrome://extensions service-worker DevTools.
  console.log("[LN-Filter SW]", ...args);
}

async function processBatch(tabId) {
  const state = ensureTab(tabId);
  if (state.running) return;
  if (state.pending.size === 0) return;

  state.running = true;
  state.cancelRef.cancelled = false;

  try {
    const settings = await getSettings();
    if (!settings.apiKey) {
      // Reject all pending — UI shows a "set API key" hint.
      for (const { post } of state.pending.values()) {
        chrome.tabs.sendMessage(tabId, {
          type: "SCORE_ERROR",
          postId: post.id,
          error: "Kein Gemini API-Key konfiguriert (Options-Seite)"
        }).catch(() => {});
      }
      state.pending.clear();
      return;
    }

    // Snapshot current pending; new arrivals during the run start a new batch on next drain.
    const batch = Array.from(state.pending.values());
    state.pending.clear();

    log(`scoring ${batch.length} posts on tab ${tabId} with ${settings.model}`);

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
        chrome.tabs.sendMessage(tabId, {
          type: "SCORE_ERROR",
          postId: post.id,
          error: e.message || String(e)
        }).catch(() => {});
        return { error: e.message };
      }
    });

    let done = 0;
    await runPool(
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

    log(`tab ${tabId} batch done (${done}/${tasks.length})`);
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
    for (const post of msg.posts) {
      if (!state.pending.has(post.id)) {
        state.pending.set(post.id, { post });
      }
    }
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

log("service worker booted");
