// Main-world bridge: lets the user type __lnfDiag() / __lnfDisable() in the
// normal page console (not just the isolated-world LN Filter context).
//
// This script runs in world: "MAIN" — so it has no access to chrome.* APIs.
// It defines globals that postMessage to the isolated-world content script,
// which handles the actual work and posts a reply back.

(() => {
  if (window.__LN_FILTER_BRIDGE__) return;
  window.__LN_FILTER_BRIDGE__ = true;

  // ----- load pacing (v0.7, opt-in) -----
  // LinkedIn loads more feed via POST .../rsc-action/actions/pagination. Gate that
  // request behind a DOM flag the isolated-world content script controls, so the
  // next batch only loads once the current one is ranked. MAIN world has no chrome.*
  // — we coordinate purely through a <html data-lnf-loadgate> attribute. This patch
  // is PASSIVE: it only delays when the content script sets the flag to "block",
  // and always fails open after MAX_HOLD_MS so the feed can never hang.
  const PAGINATION_RE = /rsc-action\/actions\/pagination/;
  const MAX_HOLD_MS = 4000;
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      if (method === "POST" && PAGINATION_RE.test(url)) {
        const self = this, args = arguments;
        return new Promise((resolve, reject) => {
          const start = Date.now();
          (function waitGate() {
            const blocked = document.documentElement.getAttribute("data-lnf-loadgate") === "block";
            if (!blocked || Date.now() - start > MAX_HOLD_MS) {
              origFetch.apply(self, args).then(resolve, reject);
            } else {
              setTimeout(waitGate, 150);
            }
          })();
        });
      }
      return origFetch.apply(this, arguments);
    };
  }

  const REQUEST = "__lnfRequest";
  const REPLY = "__lnfReply";

  function call(action, payload) {
    return new Promise(resolve => {
      const tag = Math.random().toString(36).slice(2, 10);
      function onReply(e) {
        if (e.source !== window) return;
        if (!e.data || e.data[REPLY] !== tag) return;
        window.removeEventListener("message", onReply);
        resolve(e.data.value);
      }
      window.addEventListener("message", onReply);
      window.postMessage({ [REQUEST]: tag, action, payload }, "*");
      // Safety timeout — resolves with null if isolated-world script isn't running
      setTimeout(() => {
        window.removeEventListener("message", onReply);
        resolve({ __error: "no response from content script (isolated world). Is the extension loaded?" });
      }, 1500);
    });
  }

  window.__lnfDiag = () => call("diag").then(v => {
    if (v && !v.__error) {
      console.log("=== LN Filter Diagnostics ===");
      console.table([
        { k: "version",            v: v.version },
        { k: "feed found?",        v: v.feedContainerFound },
        { k: "feed children",      v: v.feedKids },
        { k: "display-contents kids", v: v.directWrapperKids },
        { k: "kids w/ text box",   v: v.withTextBox },
        { k: "total text boxes",   v: v.textBoxes },
        { k: "tracked posts",      v: v.tracked }
      ]);
      if (v.sampleTracked?.length) console.log("sample tracked:", v.sampleTracked);
      if (v.childInfo?.length) {
        console.log("=== Per-child analysis ===");
        console.table(v.childInfo);
      }
      if (v.counters) {
        console.log("=== Counters ===");
        console.table(Object.entries(v.counters).map(([k, n]) => ({ counter: k, n })));
      }
      if (v.lastError) console.warn("=== Last error ===", v.lastError);
      console.log("settings:", v.settings);
    }
    return v;
  });

  window.__lnfDisable = () => call("disable").then(v => {
    console.log("[LN-Filter]", v?.__error || "disabled — all DOM mods reverted");
    return v;
  });

  console.log("[LN-Filter bridge] __lnfDiag() and __lnfDisable() now available in page console");
})();
