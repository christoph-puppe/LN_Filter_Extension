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

// ----- cascade control (v0.6) -----
// Global, because rate limits apply to the API key, not a tab. On a 429 we pause
// ALL scoring until cooldownUntil; un-processed posts are requeued and retried.
let cooldownUntil = 0;
// Sliding window of real (non-cached) API calls for the optional per-minute cap.
let scoreTimes = [];
function underRateCap(cap) {
  if (!cap || cap <= 0) return true;
  const cutoff = Date.now() - 60000;
  scoreTimes = scoreTimes.filter(t => t > cutoff);
  return scoreTimes.length < cap;
}
// Collapse a storm of identical errors (e.g. a dead model 404 on every post)
// into a handful of log lines instead of thousands.
const errSeen = new Map();
function logErrThrottled(key, msg) {
  const n = (errSeen.get(key) || 0) + 1;
  errSeen.set(key, n);
  if (n <= 3) logErr(msg);
  else if (n % 25 === 0) logErr(`${msg}  (×${n})`);
}

async function processBatch(tabId) {
  const state = ensureTab(tabId);
  if (state.running) return;
  if (state.pending.size === 0) return;

  // Cooldown gate: if we're paused after a 429, reschedule once and bail.
  const waitMs = cooldownUntil - Date.now();
  if (waitMs > 0) {
    if (!state.cooldownScheduled) {
      state.cooldownScheduled = true;
      setTimeout(() => { state.cooldownScheduled = false; processBatch(tabId); }, waitMs + 50);
    }
    return;
  }

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

    let rl429 = 0; // 429s seen this batch (triggers global cooldown + requeue)

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

      // Optional soft per-minute cap: defer (requeue) rather than call.
      if (!underRateCap(settings.maxScoresPerMin)) {
        state.cancelRef.cancelled = true;
        if (cooldownUntil < Date.now()) cooldownUntil = Date.now() + 5000;
        return { deferred: true };
      }

      try {
        scoreTimes.push(Date.now());
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
        // 429 = rate limit. Don't log per-call: pause everything, requeue, retry.
        if (e.status === 429) {
          rl429++;
          state.cancelRef.cancelled = true;
          if (cooldownUntil < Date.now()) {
            cooldownUntil = Date.now() + (settings.cooldownMs ?? 30000);
          }
          return { deferred: true };
        }
        logErrThrottled(emsg, `  ✗ FAIL   ${short(post.author)} :: ${emsg}`);
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

    // Tally + requeue anything deferred (429 / rate cap) or cancelled mid-pool.
    let scored = 0, cachedN = 0, failed = 0, requeued = 0;
    for (let i = 0; i < batch.length; i++) {
      const r = results[i];
      const v = r && r.value;
      const post = batch[i].post;
      if (r && r.cancelled)          { state.pending.set(post.id, { post }); requeued++; }
      else if (v && v.deferred)      { state.pending.set(post.id, { post }); requeued++; }
      else if ((r && r.error) || (v && v.error)) failed++;
      else if (v && v.cached)        cachedN++;
      else if (v && v.ok)            scored++;
    }
    const summary = `■ batch done tab ${tabId}: ${scored} scored · ${cachedN} cached · ${failed} failed${requeued ? ` · ${requeued} requeued` : ""} (${done}/${tasks.length})`;
    if (failed > 0 || rl429 > 0) warn(summary); else log(summary);

    if (rl429 > 0) {
      const secs = Math.max(0, Math.round((cooldownUntil - Date.now()) / 1000));
      warn(`⏸ rate-limited (429×${rl429}) — pausing ${secs}s, ${requeued} post(s) requeued`);
      chrome.tabs.sendMessage(tabId, { type: "RATE_LIMITED", until: cooldownUntil }).catch(() => {});
    }
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
