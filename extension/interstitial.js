(function () {
  const params = new URLSearchParams(location.search);
  const dest = params.get("dest") || "";
  const siteEl = document.getElementById("site");
  const modeEl = document.getElementById("mode");
  const receiptEl = document.getElementById("receipt");

  function base(host) {
    if (!host) return "";
    const p = host.split(".").filter(Boolean);
    return p.length <= 2 ? p.join(".") : p.slice(-2).join(".");
  }

  let siteBase = "";
  try { siteBase = base(new URL(dest).hostname); } catch {}
  siteEl.textContent = siteBase || "(unknown)";

  chrome.storage.local.get(["privacyMode"]).then(({ privacyMode }) => {
    modeEl.textContent = privacyMode || "moderate";
  });

  document.getElementById("enter").addEventListener("click", async () => {
    if (!dest) return;
    await chrome.storage.local.set({ __enterOnce: { siteBase, ts: Date.now() } });
    chrome.tabs.update({ url: dest });
   });

  

  document.getElementById("trust").addEventListener("click", async () => {
    if (!siteBase || !dest) return;
    const { trusted = [] } = await chrome.storage.local.get(["trusted"]);
    const set = new Set(trusted || []);
    set.add(siteBase);
    await chrome.storage.local.set({ trusted: [...set] });
    chrome.tabs.update({ url: dest });
  });

  document.getElementById("back").addEventListener("click", () => {
    history.length > 1 ? history.back() : window.close();
  });

  // Preview: temporarily flag preview mode and navigate
  document.getElementById("preview").addEventListener("click", async () => {
    if (!dest) return;
    const ts = Date.now();
    // mark preview intent; background will switch to strict rules and collect attempted connections
    await chrome.storage.local.set({ __preview: { ts, siteBase, dest } });
    chrome.tabs.update({ url: dest });
  });

  // If the background collected any preview receipt for this site recently, render it
  chrome.storage.local.get(["receipts"]).then(({ receipts = {} }) => {
    const items = receipts[siteBase]?.domains || [];
    for (const d of (items || []).slice(0, 6)) {
      const li = document.createElement("li");
      li.textContent = d;
      receiptEl.appendChild(li);
    }
  });
})();
