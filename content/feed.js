// Content script v0.3 — adapted to LinkedIn's hashed-class DOM (2026).
//
// Strategy:
//   - Find the feed via [data-testid="mainFeed"] (stable marker).
//   - Posts = direct children of mainFeed with [data-display-contents="true"]
//     that contain an expandable-text-box. The wrapper has display:contents
//     so we operate on wrapper.firstElementChild for layout, badge, order.
//   - Author = first a[href*="/in/"] or a[href*="/company/"] inside the post.
//   - ID = fnv1a hash of "author|first200charsOfText" (no data-urn anymore).
//   - React-resilience: re-apply attributes every scanner tick (4 Hz).
//
// Panic switches: window.__lnfDisable(), diagnostics: window.__lnfDiag().

(() => {
  "use strict";
  if (window.__LN_FILTER_LOADED__) return;
  window.__LN_FILTER_LOADED__ = true;

  // ----- selectors -----
  const FEED_SELECTOR = '[data-testid="mainFeed"]';
  const TEXT_SELECTOR = '[data-testid="expandable-text-box"]';
  // Legacy fallbacks (in case LinkedIn ships another rev)
  const LEGACY_POST_SELECTORS = [
    "div[data-urn^='urn:li:activity']",
    "div[data-id^='urn:li:activity']",
    "div.feed-shared-update-v2",
    "div.fie-impression-container"
  ];

  // ----- state -----
  const state = {
    settings: null,
    posts: new Map(),          // postId -> { wrapper, layoutEl, ... }
    visibleQueue: new Set(),
    lookaheadTimer: null,
    feedContainer: null,
    dirty: false,
    scanInterval: null,
    disabled: false,
    // Instrumentation
    counters: {
      scans: 0,
      findReturned: 0,
      registerCalls: 0,
      registerEmpty: 0,
      registerNew: 0,
      registerDup: 0,
      registerThrew: 0,
      applyThrew: 0,
      observeThrew: 0
    },
    lastError: null
  };

  const log = (...a) => console.log("[LN-Filter]", ...a);

  // ----- helpers -----
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function extractText(layoutEl) {
    const tb = layoutEl.querySelector(TEXT_SELECTOR);
    if (tb) return tb.innerText.trim();
    return layoutEl.innerText.trim().slice(0, 1500);
  }

  function extractAuthor(layoutEl) {
    const link = layoutEl.querySelector('a[href*="/in/"]')
              || layoutEl.querySelector('a[href*="/company/"]')
              || layoutEl.querySelector('a[href*="/school/"]');
    if (!link) return "";
    const txt = link.innerText.trim().split("\n")[0].slice(0, 80);
    return txt;
  }

  // Find post wrappers as direct children of mainFeed that contain a text box.
  // Returns { wrapper, layoutEl } pairs.
  function findPostsInFeed(feed) {
    const out = [];
    for (const child of feed.children) {
      const hasText = child.querySelector(TEXT_SELECTOR);
      if (!hasText) continue;
      const layoutEl =
        child.getAttribute("data-display-contents") === "true"
          ? child.firstElementChild
          : child;
      if (!layoutEl) continue;
      out.push({ wrapper: child, layoutEl });
    }
    return out;
  }

  // Legacy DOM (in case LinkedIn ships an older variant somewhere).
  function findLegacyPosts(root) {
    const out = [];
    for (const sel of LEGACY_POST_SELECTORS) {
      root.querySelectorAll(sel).forEach(el => out.push({ wrapper: el, layoutEl: el }));
    }
    return out;
  }

  // ----- score → DOM -----
  function applyMode(rec) {
    const el = rec.layoutEl;
    if (!el || !el.isConnected) return;
    const mode = state.settings?.mode || "off";
    const threshold = state.settings?.threshold ?? 45;
    const sortByScore = state.settings?.sortByScore !== false;

    // Always re-set class (React may strip)
    if (!el.classList.contains("lnf-post")) el.classList.add("lnf-post");

    el.classList.remove("lnf-hidden", "lnf-dimmed");
    el.style.removeProperty("order");

    if (rec.error) {
      el.setAttribute("data-lnf-score", "ERR");
      el.setAttribute("data-lnf-state", "error");
      el.setAttribute("title", rec.error);
    } else if (typeof rec.score === "number") {
      el.setAttribute("data-lnf-score", String(rec.score));
      el.setAttribute(
        "data-lnf-state",
        rec.score >= 70 ? "high" : rec.score >= 45 ? "mid" : "low"
      );
      el.setAttribute("title", `${rec.category || "—"} · ${rec.reason || ""}`);
      if (sortByScore) el.style.order = String(-rec.score);
      if (mode !== "off" && rec.score < threshold) {
        if (mode === "hide") el.classList.add("lnf-hidden");
        else if (mode === "dim") el.classList.add("lnf-dimmed");
      }
    } else {
      el.setAttribute("data-lnf-score", "…");
      el.setAttribute("data-lnf-state", "pending");
    }
  }

  function applyAll() {
    for (const rec of state.posts.values()) applyMode(rec);
  }

  // ----- registration -----
  function registerPost({ wrapper, layoutEl }) {
    state.counters.registerCalls++;
    try {
      const text = extractText(wrapper);
      const author = extractAuthor(wrapper);
      if (!text && !author) {
        state.counters.registerEmpty++;
        wrapper.setAttribute("data-lnf-skip", "empty");
        return null;
      }
      const id = fnv1a(`${author}|${text.slice(0, 200)}`);

      let rec = state.posts.get(id);
      if (rec) {
        state.counters.registerDup++;
        rec.wrapper = wrapper;
        rec.layoutEl = layoutEl;
        try { applyMode(rec); } catch (e) { state.counters.applyThrew++; state.lastError = "applyMode(dup): " + e.message; }
        return rec;
      }
      rec = {
        id, wrapper, layoutEl,
        author, text,
        score: undefined, category: undefined, reason: undefined,
        error: undefined, enqueued: false
      };
      state.posts.set(id, rec);
      state.counters.registerNew++;
      try { layoutEl.setAttribute("data-lnf-id", id); } catch (e) { state.lastError = "setAttr: " + e.message; }
      try { applyMode(rec); } catch (e) { state.counters.applyThrew++; state.lastError = "applyMode(new): " + e.message; }
      try { intersection.observe(layoutEl); } catch (e) { state.counters.observeThrew++; state.lastError = "observe: " + e.message; }
      return rec;
    } catch (e) {
      state.counters.registerThrew++;
      state.lastError = "registerPost: " + (e.message || String(e));
      return null;
    }
  }

  // ----- scanner (debounced) -----
  function findFeedContainer() {
    return document.querySelector(FEED_SELECTOR)
        || document.querySelector(".scaffold-finite-scroll__content")
        || null;
  }

  function scan() {
    if (state.disabled) return;
    state.counters.scans++;
    try {
      // Always re-query — LinkedIn may swap mainFeed element on route changes,
      // a cached reference goes stale (children = 0 on the old node).
      const feed = findFeedContainer();
      if (feed && feed !== state.feedContainer) {
        state.feedContainer = feed;
        rerootObserver();
        log("feed container set/changed:", feed.tagName, feed.getAttribute("data-testid") || "");
      } else if (!feed && state.feedContainer) {
        state.feedContainer = null;
      }
      let found = 0;
      if (feed) {
        const candidates = findPostsInFeed(feed);
        state.counters.findReturned += candidates.length;
        for (const p of candidates) {
          if (registerPost(p)) found++;
        }
      }
      if (found === 0) {
        for (const p of findLegacyPosts(document)) {
          if (registerPost(p)) found++;
        }
      }
      updateOverlayStatus();
      return found;
    } catch (e) {
      state.lastError = "scan: " + (e.message || String(e));
      return 0;
    }
  }

  function markDirty() { state.dirty = true; }

  function startScanner() {
    if (state.scanInterval) return;
    state.scanInterval = setInterval(() => {
      if (!state.dirty) return;
      state.dirty = false;
      scan();
    }, 250);
  }

  // ----- observers -----
  let mutation = new MutationObserver(() => markDirty());

  function rerootObserver() {
    mutation.disconnect();
    mutation = new MutationObserver(() => markDirty());
    mutation.observe(state.feedContainer, { childList: true, subtree: true });
  }

  const intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const id = entry.target.getAttribute("data-lnf-id");
        if (id) state.visibleQueue.add(id);
      }
    }
    if (state.visibleQueue.size > 0) {
      clearTimeout(intersection._timer);
      intersection._timer = setTimeout(enqueueVisible, 300);
    }
  }, { rootMargin: "200px 0px" });

  // ----- enqueue -----
  function flushEnqueue(posts) {
    if (posts.length === 0) return;
    chrome.runtime.sendMessage({
      type: "ENQUEUE_SCORE",
      posts: posts.map(rec => ({ id: rec.id, author: rec.author, text: rec.text }))
    }).catch(() => {});
  }

  function enqueueVisible() {
    const toSend = [];
    for (const id of state.visibleQueue) {
      const rec = state.posts.get(id);
      if (rec && !rec.enqueued && typeof rec.score !== "number") {
        rec.enqueued = true;
        toSend.push(rec);
      }
    }
    state.visibleQueue.clear();
    flushEnqueue(toSend);
    if (state.lookaheadTimer) clearTimeout(state.lookaheadTimer);
    state.lookaheadTimer = setTimeout(enqueueLookahead, 800);
  }

  function enqueueLookahead() {
    const lookahead = state.settings?.bulkLookahead ?? 25;
    if (lookahead <= 0) return;
    const ordered = Array.from(state.posts.values())
      .filter(r => r.layoutEl && r.layoutEl.isConnected)
      .sort((a, b) => {
        const pos = a.layoutEl.compareDocumentPosition(b.layoutEl);
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    let lastRated = -1;
    ordered.forEach((r, i) => {
      if (typeof r.score === "number" || r.enqueued) lastRated = i;
    });
    const toSend = [];
    for (let i = lastRated + 1; i < ordered.length && toSend.length < lookahead; i++) {
      const rec = ordered[i];
      if (!rec.enqueued && typeof rec.score !== "number") {
        rec.enqueued = true;
        toSend.push(rec);
      }
    }
    flushEnqueue(toSend);
  }

  // ----- inbound messages -----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GET_STATS") {
      let rated = 0, pending = 0, errors = 0;
      for (const rec of state.posts.values()) {
        if (rec.error) errors++;
        else if (typeof rec.score === "number") rated++;
        else pending++;
      }
      sendResponse({ rated, pending, errors, total: state.posts.size });
      return true;
    }
    if (msg.type === "RERATE_ALL") {
      for (const rec of state.posts.values()) {
        rec.score = rec.category = rec.reason = rec.error = undefined;
        rec.enqueued = false;
        applyMode(rec);
      }
      state.posts.forEach(rec => {
        if (rec.layoutEl && rec.layoutEl.isConnected) {
          const r = rec.layoutEl.getBoundingClientRect();
          if (r.bottom > 0 && r.top < window.innerHeight) state.visibleQueue.add(rec.id);
        }
      });
      enqueueVisible();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "SCORE_RESULT") {
      const rec = state.posts.get(msg.postId);
      if (!rec) return;
      rec.score = msg.score;
      rec.category = msg.category;
      rec.reason = msg.reason;
      rec.error = undefined;
      applyMode(rec);
      updateOverlayStatus();
    } else if (msg.type === "SCORE_ERROR") {
      const rec = state.posts.get(msg.postId);
      if (!rec) return;
      rec.error = msg.error;
      rec.enqueued = false;
      applyMode(rec);
      updateOverlayStatus();
    }
  });

  // ----- overlay -----
  let overlayEl;
  function mountOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement("div");
    overlayEl.className = "lnf-overlay";
    overlayEl.innerHTML = `
      <div class="lnf-overlay-head">
        <span class="lnf-overlay-brand">◬ LN Filter</span>
        <button class="lnf-overlay-min" title="Collapse">−</button>
      </div>
      <div class="lnf-overlay-body">
        <div class="lnf-row">
          <label class="lnf-label">Mode</label>
          <div class="lnf-seg" role="tablist">
            <button data-mode="off">Off</button>
            <button data-mode="dim">Dim</button>
            <button data-mode="hide">Hide</button>
          </div>
        </div>
        <div class="lnf-row">
          <label class="lnf-label">Threshold <span class="lnf-thr-val">45</span></label>
          <input type="range" class="lnf-thr" min="0" max="100" value="45" />
        </div>
        <div class="lnf-row">
          <label class="lnf-label"><input type="checkbox" class="lnf-sort" checked /> Sort by score</label>
        </div>
        <div class="lnf-status">
          <span class="lnf-stat-rated">0 rated</span>
          <span class="lnf-stat-pending">0 pending</span>
        </div>
        <div class="lnf-actions">
          <button class="lnf-rerate">Re-rate</button>
          <button class="lnf-options">Options</button>
        </div>
      </div>
    `;
    (document.body || document.documentElement).appendChild(overlayEl);
    wireOverlay();
    refreshOverlayFromSettings();
  }

  function wireOverlay() {
    overlayEl.querySelector(".lnf-overlay-min").addEventListener("click", () =>
      overlayEl.classList.toggle("lnf-collapsed"));
    overlayEl.querySelectorAll(".lnf-seg button").forEach(btn =>
      btn.addEventListener("click", () => saveSetting({ mode: btn.dataset.mode })));
    const thr = overlayEl.querySelector(".lnf-thr");
    const thrVal = overlayEl.querySelector(".lnf-thr-val");
    thr.addEventListener("input", () => { thrVal.textContent = thr.value; });
    thr.addEventListener("change", () => saveSetting({ threshold: Number(thr.value) }));
    overlayEl.querySelector(".lnf-sort").addEventListener("change", e =>
      saveSetting({ sortByScore: e.target.checked }));
    overlayEl.querySelector(".lnf-rerate").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
      for (const rec of state.posts.values()) {
        rec.score = rec.category = rec.reason = rec.error = undefined;
        rec.enqueued = false;
        applyMode(rec);
      }
      state.posts.forEach(rec => {
        if (rec.layoutEl && rec.layoutEl.isConnected) {
          const r = rec.layoutEl.getBoundingClientRect();
          if (r.bottom > 0 && r.top < window.innerHeight) state.visibleQueue.add(rec.id);
        }
      });
      enqueueVisible();
    });
    overlayEl.querySelector(".lnf-options").addEventListener("click", () =>
      chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {}));
  }

  function refreshOverlayFromSettings() {
    if (!overlayEl || !state.settings) return;
    overlayEl.querySelectorAll(".lnf-seg button").forEach(btn =>
      btn.classList.toggle("lnf-active", btn.dataset.mode === state.settings.mode));
    overlayEl.querySelector(".lnf-thr").value = state.settings.threshold;
    overlayEl.querySelector(".lnf-thr-val").textContent = state.settings.threshold;
    overlayEl.querySelector(".lnf-sort").checked = state.settings.sortByScore !== false;
    overlayEl.style.display = state.settings.overlayEnabled === false ? "none" : "";
  }

  function updateOverlayStatus() {
    if (!overlayEl) return;
    let rated = 0, pending = 0, errors = 0;
    for (const rec of state.posts.values()) {
      if (rec.error) errors++;
      else if (typeof rec.score === "number") rated++;
      else pending++;
    }
    overlayEl.querySelector(".lnf-stat-rated").textContent = `${rated} rated`;
    overlayEl.querySelector(".lnf-stat-pending").textContent =
      errors > 0 ? `${pending} pending · ${errors} ERR` : `${pending} pending`;
  }

  async function saveSetting(patch) {
    const { settings = {} } = await chrome.storage.local.get("settings");
    const next = { ...settings, ...patch };
    await chrome.storage.local.set({ settings: next });
    state.settings = { ...state.settings, ...patch };
    refreshOverlayFromSettings();
    applyAll();
  }

  // ----- panic / diag -----
  window.__lnfDisable = () => {
    state.disabled = true;
    mutation.disconnect();
    if (state.scanInterval) { clearInterval(state.scanInterval); state.scanInterval = null; }
    document.querySelectorAll(".lnf-post").forEach(el => {
      el.classList.remove("lnf-post", "lnf-hidden", "lnf-dimmed");
      el.style.removeProperty("order");
      el.removeAttribute("data-lnf-id");
      el.removeAttribute("data-lnf-score");
      el.removeAttribute("data-lnf-state");
    });
    if (overlayEl) overlayEl.remove();
    log("disabled — all DOM mods reverted");
  };

  function buildDiag() {
    // Force a fresh scan so diag reflects CURRENT DOM, not stale state
    scan();
    const feed = document.querySelector(FEED_SELECTOR);
    const childInfo = feed ? Array.from(feed.children).slice(0, 12).map((c, i) => ({
      i,
      tag: c.tagName,
      cls: (typeof c.className === "string" ? c.className.slice(0, 40) : ""),
      displayContents: c.getAttribute("data-display-contents") === "true",
      hasTextBox: !!c.querySelector(TEXT_SELECTOR),
      textPreview: (c.querySelector(TEXT_SELECTOR)?.innerText || "").trim().slice(0, 50),
      authorFound: !!(c.querySelector('a[href*="/in/"]') || c.querySelector('a[href*="/company/"]')),
      skipped: c.getAttribute("data-lnf-skip") || null
    })) : [];
    return {
      version: chrome.runtime.getManifest().version,
      feedContainerFound: !!feed,
      feedKids: feed?.children.length,
      cachedFeedConnected: state.feedContainer?.isConnected,
      cachedSameAsFresh: state.feedContainer === feed,
      cachedFeedKids: state.feedContainer?.children.length,
      directWrapperKids: feed ? Array.from(feed.children).filter(c =>
        c.getAttribute("data-display-contents") === "true").length : 0,
      withTextBox: feed ? Array.from(feed.children).filter(c =>
        c.querySelector(TEXT_SELECTOR)).length : 0,
      textBoxes: document.querySelectorAll(TEXT_SELECTOR).length,
      tracked: state.posts.size,
      counters: state.counters,
      lastError: state.lastError,
      sampleTracked: Array.from(state.posts.values()).slice(0, 3).map(r => ({
        id: r.id, author: r.author.slice(0, 30), preview: r.text.slice(0, 60),
        score: r.score, enqueued: r.enqueued, error: r.error
      })),
      childInfo,
      settings: state.settings
    };
  }

  window.__lnfDiag = () => {
    const out = buildDiag();
    console.log("=== LN Filter Diagnostics ===");
    console.table([{ k: "version", v: out.version }, { k: "feed?", v: out.feedContainerFound },
      { k: "feed children", v: out.feedKids }, { k: "display-contents kids", v: out.directWrapperKids },
      { k: "kids w/ text box", v: out.withTextBox }, { k: "total text boxes", v: out.textBoxes },
      { k: "tracked posts", v: out.tracked }]);
    console.log("sample tracked:", out.sampleTracked);
    console.log("settings:", out.settings);
    return out;
  };

  // Bridge: respond to MAIN-world bridge.js requests via window.postMessage
  window.addEventListener("message", e => {
    if (e.source !== window) return;
    const tag = e.data?.__lnfRequest;
    if (!tag) return;
    let value;
    if (e.data.action === "diag")    value = buildDiag();
    else if (e.data.action === "disable") {
      window.__lnfDisable();
      value = { ok: true };
    } else value = { __error: "unknown action" };
    window.postMessage({ __lnfReply: tag, value }, "*");
  });

  // ----- bootstrap -----
  async function loadSettings() {
    const { settings = {} } = await chrome.storage.local.get("settings");
    state.settings = {
      mode: "dim",
      threshold: 45,
      sortByScore: true,
      bulkLookahead: 25,
      overlayEnabled: true,
      ...settings
    };
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    state.settings = { ...state.settings, ...changes.settings.newValue };
    refreshOverlayFromSettings();
    applyAll();
  });

  async function boot() {
    await loadSettings();
    mountOverlay();
    scan();
    mutation.observe(document.body, { childList: true, subtree: true });
    startScanner();
    markDirty();
    log("v0.3 booted on", location.pathname, "— __lnfDiag() / __lnfDisable()");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
