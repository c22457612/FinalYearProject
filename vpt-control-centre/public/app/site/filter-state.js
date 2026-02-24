export function defaultFilterState() {
  return {
    kind: {
      blocked: true,
      observed: true,
      other: true,
    },
    party: "all",
    resource: "all",
    surface: "all",
    privacyStatus: "all",
    mitigationStatus: "all",
    domainText: "",
  };
}

export function defaultVizOptions() {
  return {
    metric: "seen",
    seriesType: "auto",
    topN: 20,
    sort: "value_desc",
    binSize: "5m",
    normalize: false,
    stackBars: true,
  };
}

export function getKindBucket(ev) {
  if (ev?.kind === "network.blocked") return "blocked";
  if (ev?.kind === "network.observed") return "observed";
  return "other";
}

export function getPartyBucket(ev) {
  if (ev?.data?.isThirdParty === true) return "third";
  return "first_or_unknown";
}

export function getSurfaceBucket(ev) {
  const enriched = String(ev?.enrichment?.surface || "").trim();
  if (enriched) return enriched;

  const kind = String(ev?.kind || "");
  if (kind.startsWith("network.")) return "network";
  if (kind.startsWith("cookies.")) return "cookies";
  if (kind.startsWith("storage.")) return "storage";
  if (kind.startsWith("browser_api.") || kind.startsWith("api.")) return "browser_api";
  if (kind.startsWith("script.")) return "script";
  return "unknown";
}

export function getMitigationStatusBucket(ev) {
  const enriched = String(ev?.enrichment?.mitigationStatus || "").trim();
  if (enriched) return enriched;

  const kind = String(ev?.kind || "");
  if (kind === "network.blocked") return "blocked";
  if (kind === "network.allowed") return "allowed";
  if (kind === "cookies.cleared" || kind === "cookies.removed") return "modified";
  if (
    kind === "network.observed" ||
    kind.startsWith("cookies.") ||
    kind.startsWith("storage.") ||
    kind.startsWith("browser_api.") ||
    kind.startsWith("api.") ||
    kind.startsWith("script.")
  ) {
    return "observed_only";
  }
  return "unknown";
}

export function getPrivacyStatusBucket(ev) {
  const enriched = String(ev?.enrichment?.privacyStatus || "").trim();
  if (enriched) return enriched;

  const kind = String(ev?.kind || "");
  const mitigation = getMitigationStatusBucket(ev);
  if (mitigation === "blocked") return "policy_blocked";
  if (mitigation === "allowed") return "policy_allowed";

  if (kind === "network.observed") {
    return ev?.data?.isThirdParty === true ? "signal_detected" : "baseline";
  }

  if (kind === "cookies.snapshot") {
    const thirdPartyCount = Number(ev?.data?.thirdPartyCount);
    if (Number.isFinite(thirdPartyCount) && thirdPartyCount > 0) return "signal_detected";

    const cookies = Array.isArray(ev?.data?.cookies) ? ev.data.cookies : [];
    const hasThirdPartyCookie = cookies.some((c) => c?.isThirdParty === true);
    if (hasThirdPartyCookie) return "signal_detected";
    return "baseline";
  }

  if (kind.startsWith("cookies.")) {
    return mitigation === "modified" ? "policy_blocked" : "baseline";
  }

  if (kind.startsWith("storage.")) return "baseline";
  if (kind.startsWith("browser_api.") || kind.startsWith("api.") || kind.startsWith("script.")) {
    return "signal_detected";
  }
  return "unknown";
}

export function getResourceBucket(ev) {
  const rt = String(ev?.data?.resourceType || "").toLowerCase();

  if (rt.includes("script")) return "script";
  if (rt.includes("xhr") || rt.includes("fetch") || rt.includes("xmlhttprequest")) return "xhr_fetch";
  if (rt.includes("image")) return "image";
  if (rt.includes("sub_frame") || rt.includes("subframe")) return "sub_frame";
  return "other";
}

export function matchesFilters(ev, state) {
  const kindBucket = getKindBucket(ev);
  if (!state.kind[kindBucket]) return false;

  if (state.party !== "all" && getPartyBucket(ev) !== state.party) return false;

  if (state.resource !== "all" && getResourceBucket(ev) !== state.resource) return false;

  if (state.surface !== "all" && getSurfaceBucket(ev) !== state.surface) return false;

  if (state.privacyStatus !== "all" && getPrivacyStatusBucket(ev) !== state.privacyStatus) return false;

  if (state.mitigationStatus !== "all" && getMitigationStatusBucket(ev) !== state.mitigationStatus) return false;

  const term = String(state.domainText || "").trim().toLowerCase();
  if (term) {
    const domain = String(ev?.data?.domain || "").toLowerCase();
    const url = String(ev?.data?.url || "").toLowerCase();
    const site = String(ev?.site || "").toLowerCase();

    if (!domain.includes(term) && !url.includes(term) && !site.includes(term)) {
      return false;
    }
  }

  return true;
}

export function getActiveFilterLabels(filterState) {
  const labels = [];

  const kinds = [];
  if (filterState.kind.blocked) kinds.push("blocked");
  if (filterState.kind.observed) kinds.push("observed");
  if (filterState.kind.other) kinds.push("other");
  if (kinds.length !== 3) labels.push(`kind=${kinds.join("+") || "none"}`);

  if (filterState.party !== "all") labels.push(`party=${filterState.party}`);
  if (filterState.resource !== "all") labels.push(`resource=${filterState.resource}`);
  if (filterState.surface !== "all") labels.push(`surface=${filterState.surface}`);
  if (filterState.privacyStatus !== "all") labels.push(`privacy=${filterState.privacyStatus}`);
  if (filterState.mitigationStatus !== "all") labels.push(`mitigation=${filterState.mitigationStatus}`);

  const term = String(filterState.domainText || "").trim();
  if (term) labels.push(`text=${term}`);

  return labels;
}

export function getActiveVizOptionLabels(vizOptions) {
  const labels = [];
  const defaults = defaultVizOptions();

  if (vizOptions.metric !== defaults.metric) labels.push(`metric=${vizOptions.metric}`);
  if (vizOptions.seriesType !== defaults.seriesType) labels.push(`series=${vizOptions.seriesType}`);
  if (vizOptions.topN !== defaults.topN) labels.push(`top=${vizOptions.topN}`);
  if (vizOptions.sort !== defaults.sort) labels.push(`sort=${vizOptions.sort}`);
  if (vizOptions.binSize !== defaults.binSize) labels.push(`bin=${vizOptions.binSize}`);
  if (vizOptions.normalize !== defaults.normalize) labels.push("normalize=%");
  if (vizOptions.stackBars !== defaults.stackBars) labels.push(`stack=${vizOptions.stackBars ? "on" : "off"}`);

  return labels;
}

export function readFilterStateFromControls(qs, filterState) {
  filterState.kind.blocked = !!qs("kindBlockedToggle")?.checked;
  filterState.kind.observed = !!qs("kindObservedToggle")?.checked;
  filterState.kind.other = !!qs("kindOtherToggle")?.checked;

  filterState.party = qs("partyFilter")?.value || "all";
  filterState.resource = qs("resourceFilter")?.value || "all";
  filterState.surface = qs("surfaceFilter")?.value || "all";
  filterState.privacyStatus = qs("privacyStatusFilter")?.value || "all";
  filterState.mitigationStatus = qs("mitigationStatusFilter")?.value || "all";
  filterState.domainText = qs("domainFilter")?.value || "";
}

export function writeFilterStateToControls(qs, filterState) {
  if (qs("kindBlockedToggle")) qs("kindBlockedToggle").checked = !!filterState.kind.blocked;
  if (qs("kindObservedToggle")) qs("kindObservedToggle").checked = !!filterState.kind.observed;
  if (qs("kindOtherToggle")) qs("kindOtherToggle").checked = !!filterState.kind.other;

  if (qs("partyFilter")) qs("partyFilter").value = filterState.party;
  if (qs("resourceFilter")) qs("resourceFilter").value = filterState.resource;
  if (qs("surfaceFilter")) qs("surfaceFilter").value = filterState.surface;
  if (qs("privacyStatusFilter")) qs("privacyStatusFilter").value = filterState.privacyStatus;
  if (qs("mitigationStatusFilter")) qs("mitigationStatusFilter").value = filterState.mitigationStatus;
  if (qs("domainFilter")) qs("domainFilter").value = filterState.domainText;
}

export function readVizOptionsFromControls(qs, vizOptions) {
  vizOptions.metric = qs("vizMetricSelect")?.value || "seen";
  vizOptions.seriesType = qs("vizSeriesTypeSelect")?.value || "auto";
  vizOptions.topN = Number(qs("vizTopNSelect")?.value || 20);
  vizOptions.sort = qs("vizSortSelect")?.value || "value_desc";
  vizOptions.binSize = qs("vizBinSizeSelect")?.value || "5m";
  vizOptions.normalize = !!qs("vizNormalizeToggle")?.checked;
  vizOptions.stackBars = !!qs("vizStackToggle")?.checked;
}

export function writeVizOptionsToControls(qs, vizOptions) {
  if (qs("vizMetricSelect")) qs("vizMetricSelect").value = vizOptions.metric;
  if (qs("vizSeriesTypeSelect")) qs("vizSeriesTypeSelect").value = vizOptions.seriesType;
  if (qs("vizTopNSelect")) qs("vizTopNSelect").value = String(vizOptions.topN);
  if (qs("vizSortSelect")) qs("vizSortSelect").value = vizOptions.sort;
  if (qs("vizBinSizeSelect")) qs("vizBinSizeSelect").value = vizOptions.binSize;
  if (qs("vizNormalizeToggle")) qs("vizNormalizeToggle").checked = !!vizOptions.normalize;
  if (qs("vizStackToggle")) qs("vizStackToggle").checked = !!vizOptions.stackBars;
}
