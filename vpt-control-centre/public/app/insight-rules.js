/*
 * Deterministic insight generation for selection evidence on site insights.
 * Exposes a rule engine on window.VPT.insightRules.
 */
(function initInsightRules(global) {
  const root = global.VPT = global.VPT || {};

  /** @typedef {{type:string,label:string,payload?:Record<string, any>,requiresConfirm?:boolean,confirmTitle?:string,confirmBody?:string}} PrecautionAction */
  /** @typedef {{total:number,blocked:number,observed:number,other:number,firstTs:number|null,lastTs:number|null,dominantKinds:Array<{kind:string,count:number}>}} EvidenceSummary */
  /** @typedef {{title:string,summary:string,severity:"info"|"caution"|"high",confidence:number,warnings:string[],dangers:string[],precautions:string[],actions:PrecautionAction[],evidenceSummary:EvidenceSummary}} InsightResult */

  function byKindCounts(events) {
    const counts = new Map();
    for (const ev of events) {
      const kind = String(ev?.kind || "unknown");
      counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    return counts;
  }

  function makeEvidenceSummary(events) {
    const list = Array.isArray(events) ? events.filter(Boolean) : [];
    const tsList = list.map((e) => Number(e?.ts || 0)).filter((n) => Number.isFinite(n) && n > 0);
    const firstTs = tsList.length ? Math.min(...tsList) : null;
    const lastTs = tsList.length ? Math.max(...tsList) : null;

    let blocked = 0;
    let observed = 0;
    for (const ev of list) {
      if (ev?.kind === "network.blocked") blocked += 1;
      else if (ev?.kind === "network.observed") observed += 1;
    }

    const total = list.length;
    const other = Math.max(0, total - blocked - observed);
    const kinds = Array.from(byKindCounts(list).entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([kind, count]) => ({ kind, count }));

    return { total, blocked, observed, other, firstTs, lastTs, dominantKinds: kinds };
  }

  function estimateConfidence(events) {
    const total = Array.isArray(events) ? events.length : 0;
    if (total >= 80) return 0.95;
    if (total >= 40) return 0.88;
    if (total >= 15) return 0.76;
    if (total >= 5) return 0.62;
    return 0.45;
  }

  function computeSignalStats(events) {
    const list = Array.isArray(events) ? events : [];
    let thirdParty = 0;
    let scripts = 0;
    let xhrFetch = 0;
    let lowMode = 0;
    let strictMode = 0;
    let moderateMode = 0;
    let cookieSnapshots = 0;
    let thirdPartyCookies = 0;
    const blockedByDomain = new Map();

    for (const ev of list) {
      const mode = String(ev?.mode || "").toLowerCase();
      if (mode === "low") lowMode += 1;
      if (mode === "strict") strictMode += 1;
      if (mode === "moderate") moderateMode += 1;

      if (ev?.data?.isThirdParty === true) thirdParty += 1;

      const rt = String(ev?.data?.resourceType || "").toLowerCase();
      if (rt.includes("script")) scripts += 1;
      if (rt.includes("xhr") || rt.includes("fetch") || rt.includes("xmlhttprequest")) xhrFetch += 1;

      if (ev?.kind === "network.blocked") {
        const domain = String(ev?.data?.domain || "").toLowerCase();
        if (domain) blockedByDomain.set(domain, (blockedByDomain.get(domain) || 0) + 1);
      }

      if (ev?.kind === "cookies.snapshot") {
        cookieSnapshots += 1;
        const thirdCount = Number(ev?.data?.thirdPartyCount || 0);
        if (thirdCount > 0) thirdPartyCookies += thirdCount;
      }
    }

    const maxBlockedDomain = Array.from(blockedByDomain.entries()).sort((a, b) => b[1] - a[1])[0] || null;

    return {
      total: list.length,
      thirdParty,
      scripts,
      xhrFetch,
      lowMode,
      strictMode,
      moderateMode,
      cookieSnapshots,
      thirdPartyCookies,
      maxBlockedDomain,
    };
  }

  function deriveSeverity(events, stats, vendorProfile) {
    const total = Math.max(1, events.length);
    const thirdPartyRatio = stats.thirdParty / total;
    const scriptRatio = stats.scripts / total;
    const xhrRatio = stats.xhrFetch / total;
    const hasHeavyBlockedDomain = !!stats.maxBlockedDomain && stats.maxBlockedDomain[1] >= 8;
    const isGoogle = String(vendorProfile?.vendorId || "") === "google";

    if (thirdPartyRatio >= 0.7 && (scriptRatio >= 0.4 || xhrRatio >= 0.35)) return "high";
    if (hasHeavyBlockedDomain) return "high";
    if (isGoogle && thirdPartyRatio >= 0.55) return "caution";
    if (thirdPartyRatio >= 0.45 || scriptRatio >= 0.35 || xhrRatio >= 0.3) return "caution";
    return "info";
  }

  function buildNarrative(context, summary, stats) {
    const vendorName = context?.selectedVendor?.vendorName || null;
    const scopeLabel = vendorName ? `${vendorName} activity` : "selected activity";
    const blocked = summary.blocked;
    const observed = summary.observed;

    let summaryLine = `${scopeLabel} includes ${summary.total} events (${blocked} blocked, ${observed} observed).`;
    if (vendorName && String(context?.selectedVendor?.vendorId || "") === "google") {
      summaryLine += " This likely reflects analytics/tag-manager and ad delivery infrastructure.";
    }

    const why = [];
    if (stats.thirdParty > 0) {
      why.push(`Third-party requests are present (${stats.thirdParty}/${summary.total}).`);
    }
    if (stats.scripts > 0) {
      why.push(`Script traffic is meaningful (${stats.scripts} script-type requests).`);
    }
    if (stats.xhrFetch > 0) {
      why.push(`Data endpoint traffic exists (${stats.xhrFetch} XHR/fetch requests).`);
    }

    return {
      title: vendorName ? `Insight: ${vendorName}` : "Insight: Selection",
      summary: summaryLine,
      whyThisMatters: why.length ? why.join(" ") : "This selection captures how third-party activity behaves on this site.",
    };
  }

  function buildWarnings(summary, stats, severity) {
    const warnings = [];
    if (stats.thirdParty > 0) warnings.push("Third-party data flow detected in this selection.");
    if (summary.observed > summary.blocked) warnings.push("More requests were observed than blocked in this scope.");
    if (severity === "high") warnings.push("Risk level is high based on concentration and request type mix.");
    return warnings;
  }

  function buildDangers(stats) {
    const dangers = [];
    if (stats.thirdParty > 0) dangers.push("Cross-site profiling may become easier when the same vendor appears on many sites.");
    if (stats.scripts > 0) dangers.push("Third-party scripts can execute logic that increases fingerprinting and tracking surface.");
    if (stats.xhrFetch > 0) dangers.push("XHR/fetch traffic can carry behavioral telemetry to external endpoints.");
    if (stats.cookieSnapshots > 0 && stats.thirdPartyCookies > 0) dangers.push("Third-party cookie presence may increase persistent tracking capability.");
    return dangers;
  }

  function buildPrecautions(context, stats, vendorProfile) {
    const precautions = [];
    precautions.push("Review this vendor/domain necessity against site functionality before allowing or trusting.");
    precautions.push("Prefer strict mode when testing privacy impact of third-party flows.");
    if (stats.scripts > 0) precautions.push("Prioritize script-heavy domains for tighter controls.");
    if (String(vendorProfile?.vendorId || "") === "google") {
      precautions.push("Audit Google-tag usage on this site and disable non-essential analytics/ads tags where possible.");
    }
    if (context?.viewMode === "easy") {
      precautions.push("In Easy View, actions require confirmation to reduce accidental policy changes.");
    }
    return precautions;
  }

  function buildActions(context, summary, vendorProfile) {
    const actions = [];
    const site = context?.siteName || "";
    const blockDomain = vendorProfile?.domains?.[0] || context?.selectedDomain || "";

    actions.push({
      type: "trust_site",
      label: "Trust this site",
      payload: { op: "trust_site", payload: { site } },
      requiresConfirm: true,
      confirmTitle: "Trust this site?",
      confirmBody: "Trusting bypasses some protections for this site. You can reverse this later.",
    });

    if (blockDomain) {
      actions.push({
        type: "block_domain",
        label: `Block ${blockDomain}`,
        payload: { op: "block_domain", payload: { domain: blockDomain } },
        requiresConfirm: true,
        confirmTitle: "Block this domain?",
        confirmBody: `This will add ${blockDomain} to policy filters in the extension.`,
      });
    }

    if (summary.total > 0) {
      actions.push({
        type: "export_evidence",
        label: "Export selected evidence",
        requiresConfirm: false,
      });
    }

    return actions;
  }

  /**
   * @param {{events:any[],viewId:string,viewMode:string,siteName:string,selectedVendor?:any,selectedDomain?:string}} context
   * @returns {InsightResult}
   */
  function buildInsightResult(context) {
    const events = Array.isArray(context?.events) ? context.events.filter(Boolean) : [];
    const summary = makeEvidenceSummary(events);
    const stats = computeSignalStats(events);
    const vendorProfile = context?.selectedVendor || null;
    const severity = deriveSeverity(events, stats, vendorProfile);
    const confidence = estimateConfidence(events);
    const narrative = buildNarrative(context, summary, stats);

    return {
      title: narrative.title,
      summary: `${narrative.summary} ${narrative.whyThisMatters}`.trim(),
      severity,
      confidence,
      warnings: buildWarnings(summary, stats, severity),
      dangers: buildDangers(stats),
      precautions: buildPrecautions(context, stats, vendorProfile),
      actions: buildActions(context, summary, vendorProfile),
      evidenceSummary: summary,
    };
  }

  root.insightRules = {
    buildInsightResult,
    makeEvidenceSummary,
  };
})(window);
