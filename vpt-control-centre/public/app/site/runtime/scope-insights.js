export function buildScopeSummaryModel({ events = [], kpis = {}, callouts = [] } = {}) {
  const total = Number(kpis?.total || (Array.isArray(events) ? events.length : 0) || 0);
  if (!total) {
    return {
      text: "No scoped activity yet.",
    };
  }

  const blocked = Number(kpis?.blocked || 0);
  const observed = Number(kpis?.observed || 0);
  const blockRate = Number.isFinite(kpis?.blockRate) ? Number(kpis.blockRate) : 0;
  const thirdPartyRatio = Number.isFinite(kpis?.thirdPartyRatio) ? Number(kpis.thirdPartyRatio) : 0;
  const peakBurst = Number.isFinite(kpis?.peakBurst) ? Number(kpis.peakBurst) : 0;
  const lowSample = total < 8;
  void callouts;

  const parts = [
    `${total} events in scope`,
    `${Math.round(blockRate * 100)}% blocked`,
  ];
  if (lowSample) {
    parts.push("sample still thin");
  } else if (peakBurst > 0 && total >= 8) {
    parts.push(`${peakBurst.toFixed(1)}x peak burst`);
  } else if (thirdPartyRatio > 0) {
    parts.push(`${Math.round(thirdPartyRatio * 100)}% third-party`);
  } else if (blocked === 0 && observed === 0) {
    parts.push("mostly non-network");
  }

  return { text: `${parts.join(" • ")}.` };
}

export function createScopeInsights(deps) {
  const {
    qs,
    getSiteLens,
    getTimelineBinMs,
  } = deps;

  function renderLensNotice({ active = false } = {}) {
    void active;
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
    };
  }

  function renderScopeInsights(events) {
    const lensApi = getSiteLens();
    const summaryEl = qs("vizScopeSummary");
    if (!summaryEl) return;

    const list = Array.isArray(events) ? events : [];
    const kpis = lensApi?.buildScopeKpis
      ? lensApi.buildScopeKpis(list, getTimelineBinMs())
      : buildFallbackScopeKpis(list);
    const callouts = lensApi?.buildScopeCallouts
      ? lensApi.buildScopeCallouts(list, kpis)
      : [];
    const summary = buildScopeSummaryModel({ events: list, kpis, callouts });
    summaryEl.textContent = summary.text;
  }

  return {
    renderLensNotice,
    renderScopeInsights,
  };
}
