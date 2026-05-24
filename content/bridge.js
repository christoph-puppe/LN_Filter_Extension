// Main-world bridge: lets the user type __lnfDiag() / __lnfDisable() in the
// normal page console (not just the isolated-world LN Filter context).
//
// This script runs in world: "MAIN" — so it has no access to chrome.* APIs.
// It defines globals that postMessage to the isolated-world content script,
// which handles the actual work and posts a reply back.

(() => {
  if (window.__LN_FILTER_BRIDGE__) return;
  window.__LN_FILTER_BRIDGE__ = true;

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
