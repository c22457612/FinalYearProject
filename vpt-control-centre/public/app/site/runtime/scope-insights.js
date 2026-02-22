export function createScopeInsights(deps) {
  const {
    qs,
    getSiteLens,
    getTimelineBinMs,
    formatPercent,
    onForceCompare,
  } = deps;

  function renderLensNotice({ active = false, vendorName = "" } = {}) {
    const box = qs("vizLensNotice");
    if (!box) return;

    if (!active) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }

    box.classList.remove("hidden");
    box.innerHTML = "";

    const msg = document.createElement("div");
    msg.className = "viz-lens-message";
    msg.textContent = `Focused lens active${vendorName ? ` for ${vendorName}` : ""}: compare view had too few bars to be informative.`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "viz-lens-action";
    btn.textContent = "Show compare anyway";
    btn.addEventListener("click", () => {
      if (typeof onForceCompare === "function") onForceCompare();
    });

    box.appendChild(msg);
    box.appendChild(btn);
  }

  function buildFallbackScopeKpis(events) {
    const list = Array.isArray(events) ? events : [];
    let blocked = 0;
    let observed = 0;
    let thirdParty = 0;
    for (const ev of list) {
      if (ev?.kind === "network.blocked") blocked += 1;
      if (ev?.kind === "network.observed") observed += 1;
      if (ev?.data?.isThirdParty === true) thirdParty += 1;
    }

    return {
      total: list.length,
      blocked,
      observed,
      thirdParty,
      blockRate: blocked / Math.max(1, blocked + observed),
      thirdPartyRatio: thirdParty / Math.max(1, list.length),
      peakBurst: 0,
      maxBin: 0,
      medianNonZeroBin: 0,
    };
  }

  function renderScopeInsights(events) {
    const lensApi = getSiteLens();
    const kpiBox = qs("vizKpiStrip");
    const calloutBox = qs("vizCallouts");
    const list = Array.isArray(events) ? events : [];
    const kpis = lensApi?.buildScopeKpis
      ? lensApi.buildScopeKpis(list, getTimelineBinMs())
      : buildFallbackScopeKpis(list);

    if (kpiBox) {
      kpiBox.innerHTML = "";
      const cards = [
        { label: "Events", value: String(Number(kpis.total || 0)) },
        { label: "Block rate", value: formatPercent(kpis.blockRate) },
        { label: "3P ratio", value: formatPercent(kpis.thirdPartyRatio) },
        { label: "Peak burst", value: `${Number(kpis.peakBurst || 0).toFixed(2)}x` },
      ];

      for (const card of cards) {
        const item = document.createElement("div");
        item.className = "viz-kpi-card";
        const label = document.createElement("div");
        label.className = "viz-kpi-label";
        label.textContent = card.label;
        const value = document.createElement("div");
        value.className = "viz-kpi-value";
        value.textContent = card.value;
        item.appendChild(label);
        item.appendChild(value);
        kpiBox.appendChild(item);
      }
    }

    if (calloutBox) {
      calloutBox.innerHTML = "";
      const callouts = lensApi?.buildScopeCallouts
        ? lensApi.buildScopeCallouts(list, kpis)
        : ["Scope insights unavailable."];
      for (const text of callouts) {
        const li = document.createElement("li");
        li.textContent = String(text || "");
        calloutBox.appendChild(li);
      }
    }
  }

  return {
    renderLensNotice,
    renderScopeInsights,
  };
}
