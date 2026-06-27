// Content script v0.6 — rank-then-show on LinkedIn's hashed-class DOM (2026).
//
// Strategy:
//   - Find the feed via [data-testid="mainFeed"] (stable marker).
//   - A post = direct child of mainFeed containing an expandable-text-box;
//     resolveLayoutEl() descends past display:contents wrappers to the real box.
//   - Author = first a[href*="/in/"] or a[href*="/company/"] inside the post.
//   - ID = fnv1a hash of "author|first200charsOfText" (stable across re-renders).
//   - React-resilience: re-apply attributes every scanner tick (4 Hz) + on mutation.
//
// v0.6: HIDE mode HOLDS unscored posts hidden (lnf-gate, display:none) until they
// have a rank, so they never flash-then-collapse. Scoring is driven by DOM
// position (pumpQueue), not visibility, because gated posts never intersect.
// Bounded by gateBudget + gateTimeoutMs; the worker handles 429 backoff.
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

  // IntersectionObserver and CSS `order` both ignore display:contents elements
  // (they generate no layout box). As of 2026 LinkedIn wraps each post in one or
  // more display:contents <div>s and no longer ships the data-display-contents
  // marker, so the old attribute check fell through to the contents wrapper —
  // IO never fired, posts never got enqueued, nothing was ever scored.
  // Descend to the first descendant that actually generates a box. With the
  // outer wrappers display:contents, that inner box IS the participating flex
  // item of mainFeed, so order-based sorting works on it too.
  function resolveLayoutEl(wrapper) {
    let node = wrapper;
    for (let i = 0; i < 6 && node; i++) {
      if (getComputedStyle(node).display !== "contents") return node;
      node = node.firstElementChild;
    }
    return wrapper.firstElementChild || wrapper;
  }

  // Find post wrappers as direct children of mainFeed that contain a text box.
  // Returns { wrapper, layoutEl } pairs.
  function findPostsInFeed(feed) {
    const out = [];
    for (const child of feed.children) {
      const hasText = child.querySelector(TEXT_SELECTOR);
      if (!hasText) continue;
      const layoutEl = resolveLayoutEl(child);
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

  // ----- reveal gating (v0.6 hold-until-ranked) -----
  // In HIDE mode, hold an unscored post hidden (display:none) until it has a
  // rank, so it never flashes-then-collapses in view. Bounded by gateBudget
  // (don't shrink the column without limit → the load cascade) and gateTimeoutMs
  // (never trap content behind a stalled queue). Fail-open everywhere.
  const gatedSet = new Set(); // rec.id currently held

  function decideGate(rec) {
    const budget  = state.settings?.gateBudget ?? 12;
    const timeout = state.settings?.gateTimeoutMs ?? 6000;
    const now = Date.now();
    if (rec.gateStart === -1) return false;          // timed out earlier → stay revealed
    if (rec.gateStart == null) {
      if (gatedSet.size >= budget) return false;     // budget full → show ungated
      rec.gateStart = now;
      return true;
    }
    if (now - rec.gateStart > timeout) { rec.gateStart = -1; return false; } // fail-open
    return true;
  }

  // ----- score → DOM -----
  function applyMode(rec) {
    const el = rec.layoutEl;
    if (!el || !el.isConnected) { gatedSet.delete(rec.id); return; }
    const mode = state.settings?.mode || "off";
    const threshold = state.settings?.threshold ?? 45;
    const sortByScore = state.settings?.sortByScore !== false;

    // Always re-set class (React may strip)
    if (!el.classList.contains("lnf-post")) el.classList.add("lnf-post");

    el.classList.remove("lnf-hidden", "lnf-dimmed", "lnf-gate");
    el.style.removeProperty("order");

    let gated = false;
    if (rec.error) {
      // fail-open: reveal posts we couldn't score (never trap content)
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
      // pending — in HIDE mode hold it until ranked rather than flashing "…"
      el.setAttribute("data-lnf-score", "…");
      if (mode === "hide" && decideGate(rec)) {
        gated = true;
        el.classList.add("lnf-gate");
        el.setAttribute("data-lnf-state", "gated");
      } else {
        el.setAttribute("data-lnf-state", "pending");
      }
    }
    if (gated) gatedSet.add(rec.id); else gatedSet.delete(rec.id);
  }

  function applyAll() {
    for (const rec of state.posts.values()) applyMode(rec);
  }

  // ----- batched apply -----
  // Scores arrive asynchronously; applying each one in its own synchronous pass
  // caused redundant reflows. Coalesce all updates that land in the same frame
  // into a single pass via requestAnimationFrame. We deliberately do NOT touch
  // the scroll position here — manually correcting scrollTop fought LinkedIn's
  // own infinite-scroll handler and produced an error storm (v0.5.2). Native
  // browser scroll anchoring handles viewport stability on its own.
  let applyRaf = 0;
  let applyAllReq = false;
  const dirtyRecs = new Set();

  function flushApply() {
    applyRaf = 0;
    try {
      if (applyAllReq) {
        applyAllReq = false;
        dirtyRecs.clear();
        applyAll();
      } else {
        for (const rec of dirtyRecs) applyMode(rec);
        dirtyRecs.clear();
      }
    } catch (e) {
      state.lastError = "flushApply: " + (e.message || String(e));
    }
  }

  function schedule() {
    if (!applyRaf) applyRaf = requestAnimationFrame(flushApply);
  }
  function scheduleApply(rec) { if (rec) dirtyRecs.add(rec); schedule(); }
  function scheduleApplyAll() { applyAllReq = true; schedule(); }

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
        if (rec.layoutEl !== layoutEl) {
          // React swapped this post's box for a fresh node. Move our tracking
          // over: re-tag it and re-point the IntersectionObserver — otherwise the
          // observer keeps watching the detached old node and the post never
          // enqueues for scoring (stuck at "…" until a manual Re-rate).
          try { intersection.unobserve(rec.layoutEl); } catch (e) {}
          rec.layoutEl = layoutEl;
          try { layoutEl.setAttribute("data-lnf-id", id); } catch (e) { state.lastError = "setAttr(dup): " + e.message; }
          try { intersection.observe(layoutEl); } catch (e) { state.counters.observeThrew++; state.lastError = "observe(dup): " + e.message; }
        }
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
      schedulePump();
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
  // Coalesce mutation bursts into a single scan on the next frame — fast enough
  // to gate a freshly-inserted post before it paints, without scanning per-mutation.
  let scanRaf = 0;
  function requestScan() {
    state.dirty = true;
    if (scanRaf) return;
    scanRaf = requestAnimationFrame(() => {
      scanRaf = 0;
      if (state.dirty) { state.dirty = false; scan(); }
    });
  }

  let mutation = new MutationObserver(requestScan);

  function rerootObserver() {
    mutation.disconnect();
    mutation = new MutationObserver(requestScan);
    mutation.observe(state.feedContainer, { childList: true, subtree: true });
  }

  // The IntersectionObserver is now only a scroll/visibility *signal*. Gated posts
  // are display:none and never intersect, so the actual enqueueing is driven by
  // DOM position in pumpQueue(), not by visibility.
  const intersection = new IntersectionObserver(() => schedulePump(), { rootMargin: "300px 0px" });

  // ----- enqueue (position-based, v0.6) -----
  // Score by DOM position, not CSS visibility: every unscored post from the top
  // of the feed through `lookahead` posts past the viewport, plus any gated post
  // (which needs a score to ever un-gate).
  function orderedConnectedPosts() {
    return Array.from(state.posts.values())
      .filter(r => r.layoutEl && r.layoutEl.isConnected)
      .sort((a, b) =>
        (a.layoutEl.compareDocumentPosition(b.layoutEl) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  }

  function needsScore(rec) {
    return !rec.enqueued && typeof rec.score !== "number" && !rec.error;
  }

  function flushEnqueue(posts) {
    if (posts.length === 0) return;
    log(`→ enqueue ${posts.length} post(s) for scoring`);
    chrome.runtime.sendMessage({
      type: "ENQUEUE_SCORE",
      posts: posts.map(rec => ({ id: rec.id, author: rec.author, text: rec.text }))
    }).catch(e => log("enqueue sendMessage failed (service worker down?):", e?.message || e));
  }

  function pumpQueue() {
    if (state.disabled) return;
    const lookahead = Math.max(0, state.settings?.bulkLookahead ?? 30);
    const ordered = orderedConnectedPosts();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    // Frontier = lowest *non-gated* post within the viewport + margin. Gated
    // posts are display:none (rect top = 0) so they can't anchor position.
    let frontier = 0;
    ordered.forEach((r, i) => {
      if (r.layoutEl.classList.contains("lnf-gate")) return;
      if (r.layoutEl.getBoundingClientRect().top < vh + 300) frontier = i;
    });
    const limit = Math.min(ordered.length - 1, frontier + lookahead);
    const toSend = [];
    for (let i = 0; i <= limit; i++) {
      if (needsScore(ordered[i])) { ordered[i].enqueued = true; toSend.push(ordered[i]); }
    }
    // Gated posts must be scored to ever un-gate, regardless of the window.
    for (const rec of state.posts.values()) {
      if (rec.layoutEl && rec.layoutEl.classList.contains("lnf-gate") && needsScore(rec)) {
        rec.enqueued = true; toSend.push(rec);
      }
    }
    flushEnqueue(toSend);
  }

  let pumpTimer = null;
  function schedulePump() {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => { pumpTimer = null; pumpQueue(); }, 200);
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
        rec.gateStart = undefined;   // allow re-gating on re-rate
        applyMode(rec);
      }
      pumpQueue();
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
      scheduleApply(rec);
      updateOverlayStatus();
    } else if (msg.type === "SCORE_ERROR") {
      const rec = state.posts.get(msg.postId);
      if (!rec) return;
      rec.error = msg.error;
      rec.enqueued = false;
      scheduleApply(rec);
      updateOverlayStatus();
    } else if (msg.type === "RATE_LIMITED") {
      // SW paused on a 429; posts are requeued there and retry after cooldown.
      state.rateLimitedUntil = msg.until || 0;
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
        <div class="lnf-row">
          <label class="lnf-label"><input type="checkbox" class="lnf-pace" /> Pace loading (exp)</label>
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
    overlayEl.querySelector(".lnf-pace").addEventListener("change", e =>
      saveSetting({ paceLoading: e.target.checked }));
    overlayEl.querySelector(".lnf-rerate").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
      for (const rec of state.posts.values()) {
        rec.score = rec.category = rec.reason = rec.error = undefined;
        rec.enqueued = false;
        rec.gateStart = undefined;
        applyMode(rec);
      }
      pumpQueue();
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
    overlayEl.querySelector(".lnf-pace").checked = state.settings.paceLoading === true;
    overlayEl.style.display = state.settings.overlayEnabled === false ? "none" : "";
    updateLoadGate();
  }

  // v0.7 load pacing: publish a gate flag the MAIN-world fetch patch reads.
  // "block" = still ranking a backlog → hold LinkedIn's next pagination fetch;
  // "allow"/absent = let it through. Passive unless paceLoading is enabled.
  function updateLoadGate() {
    const root = document.documentElement;
    if (state.settings?.paceLoading !== true) { root.removeAttribute("data-lnf-loadgate"); return; }
    let pending = 0;
    for (const rec of state.posts.values()) {
      if (!rec.error && typeof rec.score !== "number") pending++;
    }
    const backlog = gatedSet.size + pending;
    root.setAttribute("data-lnf-loadgate", backlog > (state.settings?.gateBudget ?? 12) ? "block" : "allow");
  }

  function updateOverlayStatus() {
    updateLoadGate();
    if (!overlayEl) return;
    let rated = 0, pending = 0, errors = 0;
    for (const rec of state.posts.values()) {
      if (rec.error) errors++;
      else if (typeof rec.score === "number") rated++;
      else pending++;
    }
    const held = gatedSet.size;
    overlayEl.querySelector(".lnf-stat-rated").textContent = `${rated} rated`;
    let right = held > 0 ? `${held} held · ${pending} pending` : `${pending} pending`;
    if (errors > 0) right += ` · ${errors} ERR`;
    overlayEl.querySelector(".lnf-stat-pending").textContent = right;
  }

  // Base the write on our in-memory settings (kept current via storage.onChanged),
  // NOT a fresh storage read. Two rapid saveSetting calls — e.g. switch to Hide,
  // then nudge the threshold — would otherwise both read the same pre-change
  // snapshot, and the second write would clobber the first, silently reverting
  // the mode back to its previous value ("hide turns itself off").
  async function saveSetting(patch) {
    state.settings = { ...state.settings, ...patch };
    const snapshot = state.settings;
    refreshOverlayFromSettings();
    scheduleApplyAll();
    await chrome.storage.local.set({ settings: snapshot });
  }

  // ----- panic / diag -----
  window.__lnfDisable = () => {
    state.disabled = true;
    mutation.disconnect();
    if (state.scanInterval) { clearInterval(state.scanInterval); state.scanInterval = null; }
    document.querySelectorAll(".lnf-post").forEach(el => {
      el.classList.remove("lnf-post", "lnf-hidden", "lnf-dimmed", "lnf-gate");
      el.style.removeProperty("order");
      el.removeAttribute("data-lnf-id");
      el.removeAttribute("data-lnf-score");
      el.removeAttribute("data-lnf-state");
    });
    document.documentElement.removeAttribute("data-lnf-loadgate");
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
      gated: gatedSet.size,
      filtered: Array.from(state.posts.values()).filter(r =>
        r.layoutEl?.classList.contains("lnf-hidden")).length,
      rateLimitedUntil: state.rateLimitedUntil || 0,
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
      bulkLookahead: 30,
      overlayEnabled: true,
      gateBudget: 12,
      gateTimeoutMs: 6000,
      paceLoading: false,
      ...settings
    };
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    state.settings = { ...state.settings, ...changes.settings.newValue };
    refreshOverlayFromSettings();
    scheduleApplyAll();
  });

  // Scrolling alone doesn't mutate the DOM, so the mutation observer won't fire —
  // drive the position-based queue off scroll directly (capture phase catches the
  // inner <main> scroller, whose scroll events don't bubble to window).
  function onScroll() { schedulePump(); }

  // Reload resilience: LinkedIn auto-refreshes the feed on tab re-focus and on its
  // own idle timer. Force a re-scan + re-apply the moment we become visible so the
  // re-rank snaps back (scores come from the SW cache → no new API calls).
  function onRefocus() {
    if (document.visibilityState !== "hidden") { requestScan(); schedulePump(); }
  }

  async function boot() {
    await loadSettings();
    mountOverlay();
    scan();
    mutation.observe(document.body, { childList: true, subtree: true });
    startScanner();
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onRefocus);
    window.addEventListener("focus", onRefocus);
    markDirty();
    schedulePump();
    log("v0.7 booted on", location.pathname, "— __lnfDiag() / __lnfDisable()");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
