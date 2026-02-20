/*
 * Deterministic helpers for focused single-site/single-vendor lens behavior.
 * Exposes helper methods on window.VPT.siteLens.
 */
(function initSiteLens(global) {
  const root = global.VPT = global.VPT || {};

  function toList(events) {
    return Array.isArray(events) ? events.filter(Boolean) : [];
  }

  function classifyVendorId(ev) {
    const taxonomy = root.vendorTaxonomy;
    if (taxonomy?.classifyEvent) {
      const profile = taxonomy.classifyEvent(ev);
      if (profile?.vendorId) return String(profile.vendorId);
    }

    const domain = String(ev?.data?.domain || ev?.site || "").trim().toLowerCase();
    return domain || "unknown";
  }

  function countUniqueVendors(events) {
    const ids = new Set();
    for (const ev of toList(events)) ids.add(classifyVendorId(ev));
    return ids.size;
  }

  function shouldAutoPivotVendorOverview(context) {
    if (String(context?.viewId || "") !== "vendorOverview") return false;
    if (!context?.selectedVendor?.vendorId) return false;

    const explicitCardinality = Number(context?.vendorCardinality);
    if (Number.isFinite(explicitCardinality)) return explicitCardinality <= 1;

    const list = toList(context?.events);
    return countUniqueVendors(list) <= 1;
  }

  function makeBins(events, binMs) {
    const list = toList(events);
    const safeBin = Math.max(60 * 1000, Number(binMs) || 60 * 1000);
    if (!list.length) {
      return {
        values: [],
        maxBin: 0,
        medianNonZeroBin: 0,
      };
    }

    const tsList = list.map((ev) => Number(ev?.ts || 0)).filter((n) => Number.isFinite(n) && n > 0);
    if (!tsList.length) {
      return {
        values: [list.length],
        maxBin: list.length,
        medianNonZeroBin: list.length,
      };
    }

    const minTs = Math.min(...tsList);
    const maxTs = Math.max(...tsList);
    const span = Math.max(1, (maxTs - minTs) + 1);
    const bins = Math.max(1, Math.ceil(span / safeBin));
    const counts = new Array(bins).fill(0);

    for (const ts of tsList) {
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((ts - minTs) / safeBin)));
      counts[idx] += 1;
    }

    const nonZero = counts.filter((n) => n > 0).sort((a, b) => a - b);
    const middle = Math.floor(nonZero.length / 2);
    const median = nonZero.length
      ? (nonZero.length % 2 ? nonZero[middle] : (nonZero[middle - 1] + nonZero[middle]) / 2)
      : 0;

    return {
      values: counts,
      maxBin: counts.length ? Math.max(...counts) : 0,
      medianNonZeroBin: median,
    };
  }

  function getResourceBucket(ev) {
    const rt = String(ev?.data?.resourceType || "").toLowerCase();
    if (rt.includes("script")) return "script";
    if (rt.includes("xhr") || rt.includes("fetch") || rt.includes("xmlhttprequest")) return "xhr/fetch";
    if (rt.includes("image")) return "image";
    if (rt.includes("sub_frame") || rt.includes("subframe")) return "sub-frame";
    return "other";
  }

  function buildScopeKpis(events, binMs) {
    const list = toList(events);
    let blocked = 0;
    let observed = 0;
    let thirdParty = 0;

    for (const ev of list) {
      if (ev?.kind === "network.blocked") blocked += 1;
      if (ev?.kind === "network.observed") observed += 1;
      if (ev?.data?.isThirdParty === true) thirdParty += 1;
    }

    const binStats = makeBins(list, binMs);
    const denominator = Math.max(1, blocked + observed);
    const blockRate = blocked / denominator;
    const thirdPartyRatio = thirdParty / Math.max(1, list.length);
    const peakBurst = binStats.maxBin / Math.max(1, binStats.medianNonZeroBin);

    return {
      total: list.length,
      blocked,
      observed,
      thirdParty,
      blockRate,
      thirdPartyRatio,
      peakBurst,
      maxBin: binStats.maxBin,
      medianNonZeroBin: binStats.medianNonZeroBin,
    };
  }

  function topShare(entries, total) {
    const sorted = Array.from(entries.entries()).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return null;
    const top = sorted[0];
    return {
      label: String(top[0]),
      count: Number(top[1]),
      share: Number(top[1]) / Math.max(1, total),
    };
  }

  function dominantMode(events) {
    const modeCounts = new Map();
    for (const ev of toList(events)) {
      const mode = String(ev?.mode || "unknown").toLowerCase();
      modeCounts.set(mode, (modeCounts.get(mode) || 0) + 1);
    }
    const top = topShare(modeCounts, toList(events).length);
    return top ? top.label : "unknown";
  }

  function buildScopeCallouts(events, kpis) {
    const list = toList(events);
    const total = Number(kpis?.total || list.length || 0);
    const lowSample = total < 8;

    const byDomain = new Map();
    const byResource = new Map();
    const byKind = new Map();
    for (const ev of list) {
      const domain = String(ev?.data?.domain || ev?.site || "unknown");
      byDomain.set(domain, (byDomain.get(domain) || 0) + 1);

      const resource = getResourceBucket(ev);
      byResource.set(resource, (byResource.get(resource) || 0) + 1);

      const kind = String(ev?.kind || "unknown");
      byKind.set(kind, (byKind.get(kind) || 0) + 1);
    }

    const topDomain = topShare(byDomain, total);
    const topResource = topShare(byResource, total);
    const topKind = topShare(byKind, total);

    const concentrationCandidates = [
      topDomain ? { dimension: "domain", ...topDomain } : null,
      topResource ? { dimension: "resource", ...topResource } : null,
      topKind ? { dimension: "kind", ...topKind } : null,
    ].filter(Boolean).sort((a, b) => b.share - a.share);
    const concentration = concentrationCandidates[0] || null;

    const c1 = concentration
      ? `Strongest concentration is ${concentration.dimension} "${concentration.label}" (${(concentration.share * 100).toFixed(1)}% of scoped events).`
      : "No concentration signal yet in the current scoped events.";

    const burst = Number(kpis?.peakBurst || 0);
    const maxBin = Number(kpis?.maxBin || 0);
    const median = Number(kpis?.medianNonZeroBin || 0);
    let c2 = `Peak burst is ${burst.toFixed(2)}x baseline (peak bin ${maxBin}, median non-zero bin ${median.toFixed(2)}).`;
    if (burst >= 2.5) c2 += " Activity appears spiky rather than evenly distributed.";
    else c2 += " Activity is relatively steady across bins.";

    const blocked = Number(kpis?.blocked || 0);
    const observed = Number(kpis?.observed || 0);
    const mode = dominantMode(list);
    let c3 = "";
    if (blocked > observed) {
      c3 = `Protection posture is assertive: more requests were blocked (${blocked}) than observed (${observed}); dominant mode is ${mode}.`;
    } else if (observed > blocked) {
      c3 = `Protection posture is permissive in this scope: observed requests (${observed}) exceed blocked (${blocked}); dominant mode is ${mode}.`;
    } else {
      c3 = `Protection posture is balanced: blocked and observed requests are equal (${blocked}); dominant mode is ${mode}.`;
    }

    if (lowSample) {
      return [
        `${c1} Low confidence due to small sample (<8 events).`,
        `${c2} Collect more evidence before making policy changes.`,
        `${c3} Treat this as directional until more events are captured.`,
      ];
    }

    return [c1, c2, c3];
  }

  root.siteLens = {
    shouldAutoPivotVendorOverview,
    buildScopeKpis,
    buildScopeCallouts,
  };
})(window);
