export function defaultFilterState() {
  return {
    kind: {
      blocked: true,
      observed: true,
      other: true,
    },
    party: "all",
    resource: "all",
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
  filterState.domainText = qs("domainFilter")?.value || "";
}

export function writeFilterStateToControls(qs, filterState) {
  if (qs("kindBlockedToggle")) qs("kindBlockedToggle").checked = !!filterState.kind.blocked;
  if (qs("kindObservedToggle")) qs("kindObservedToggle").checked = !!filterState.kind.observed;
  if (qs("kindOtherToggle")) qs("kindOtherToggle").checked = !!filterState.kind.other;

  if (qs("partyFilter")) qs("partyFilter").value = filterState.party;
  if (qs("resourceFilter")) qs("resourceFilter").value = filterState.resource;
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
