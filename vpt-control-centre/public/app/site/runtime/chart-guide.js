const CHART_GUIDE_BY_VIEW_ID = Object.freeze({
  vendorOverview: Object.freeze({
    what: "Which vendors are most active in this scope.",
    how: [
      "Each bar is one vendor; taller bars mean more events.",
      "Blocked, observed, blocked API, observed API, and other segments show outcome mix.",
      "Use vendor focus chips to inspect one vendor.",
    ],
    bestFor: [
      "Spotting dominant vendors quickly.",
      "Comparing vendor activity balance.",
    ],
    gotcha: "Sparse vendor scopes may compact to a timeline-style focus.",
    powerDetail: "Switch metric to compare seen, blocked, or observed emphasis.",
  }),
  vendorShareOverTime: Object.freeze({
    what: "How top vendors share total activity across time in this scope.",
    how: [
      "Each stacked area shows one vendor's contribution by time bin.",
      "Top vendors are shown directly; long-tail vendors are grouped as Other.",
      "Use tooltip totals to compare both counts and share per time bin.",
    ],
    bestFor: [
      "Seeing who dominates activity over time.",
      "Spotting vendor-share shifts during bursts.",
    ],
    gotcha: "Vendor focus hides comparison views; clear vendor focus to compare vendors.",
    powerDetail: "Adjust range/bin size to stabilize noisy short-window share swings.",
  }),
  vendorAllowedBlockedTimeline: Object.freeze({
    what: "How one vendor changed over time, split by blocked and observed outcomes.",
    how: [
      "X-axis is time bins; Y-axis is event count.",
      "Series compare blocked and observed activity per bin.",
      "Brush a window to inspect one period.",
    ],
    bestFor: [
      "Finding bursts for a selected vendor.",
      "Checking blocked-vs-observed trend shifts.",
    ],
    gotcha: "Most useful when a vendor is selected.",
    powerDetail: "Bin size controls spike sensitivity versus smoothing.",
  }),
  vendorTopDomainsEndpoints: Object.freeze({
    what: "Where the selected vendor connects most (domains and endpoint buckets).",
    how: [
      "Each row is a domain-endpoint bucket.",
      "Stacked segments show blocked, observed, blocked API, observed API, and other counts.",
      "Click a row to scope evidence to that bucket.",
    ],
    bestFor: [
      "Finding top destinations for one vendor.",
      "Identifying blocked-heavy endpoint buckets.",
    ],
    gotcha: "Requires vendor focus; sparse scopes may show compact fallback.",
    powerDetail: "Top N and sort help surface long-tail endpoint patterns.",
  }),
  baselineDetectedBlockedTrend: Object.freeze({
    what: "How baseline, detected, and blocked outcomes change over time.",
    how: [
      "Baseline means no signal detected in that event.",
      "Detected and blocked lines show signal and mitigation flow by time bin.",
      "Compare movement between all three series.",
    ],
    bestFor: [
      "Tracking protection balance over time.",
      "Explaining whether detections are being mitigated.",
    ],
    gotcha: "Baseline is not a guarantee of safety.",
    powerDetail: "Combine with mitigation filter for policy-specific trends.",
  }),
  timeline: Object.freeze({
    what: "When total activity happened across the selected range.",
    how: [
      "X-axis is time; Y-axis is event count.",
      "Blocked, observed, blocked API, observed API, and other show per-bin mix.",
      "Brush to lock a period and inspect its evidence.",
    ],
    bestFor: [
      "Finding busy periods quickly.",
      "Reading overall activity rhythm.",
    ],
    gotcha: "Very narrow ranges may hide slower patterns.",
    powerDetail: "Adjust bin size to trade detail for readability.",
  }),
  topSeen: Object.freeze({
    what: "Which third-party domains appeared most often.",
    how: [
      "Each bar is one domain ranked by count.",
      "Longer bars mean more observed appearances.",
      "Filters narrow the domain set.",
    ],
    bestFor: [
      "Identifying dominant third parties.",
      "Prioritizing domains for review.",
    ],
    gotcha: "Very low counts can cause ties in ranking.",
    powerDetail: "Sort and Top N expose head-versus-tail differences.",
  }),
  kinds: Object.freeze({
    what: "Which event types are most common in this scope.",
    how: [
      "Each bar represents an event-type bucket.",
      "Bar height is total count.",
      "Compare blocked and observed mix by event type.",
    ],
    bestFor: [
      "Quick event-type mix checks.",
      "Validating capture patterns.",
    ],
    gotcha: "Outcome toggles can hide categories.",
    powerDetail: "Combine with signal surface filtering for tighter comparisons.",
  }),
  apiGating: Object.freeze({
    what: "How often third-party API-like requests appear and how they resolve.",
    how: [
      "Bars group third-party API-like request buckets.",
      "Height reflects frequency in current scope.",
      "Outcome split shows blocked versus observed balance.",
    ],
    bestFor: [
      "Checking API-style tracker pressure.",
      "Spotting repeated suspicious call classes.",
    ],
    gotcha: "Heuristic grouping can under/over-group rare calls.",
    powerDetail: "Pair with domain filter for targeted investigation.",
  }),
  ruleIdFrequency: Object.freeze({
    what: "Which rule IDs trigger most often in the current scope.",
    how: [
      "Each bar is one rule ID.",
      "Height is trigger count.",
      "Clicking a bar scopes evidence to that rule.",
    ],
    bestFor: [
      "Prioritizing recurring rule patterns.",
      "Explaining which rules drive alerts.",
    ],
    gotcha: "Not all events map to a rule ID.",
    powerDetail: "Pair with trend views to connect rule spikes to time windows.",
  }),
  resourceTypes: Object.freeze({
    what: "What resource classes dominate captured activity.",
    how: [
      "Bars represent resource types such as script or image.",
      "Height shows event count per resource type.",
      "Compare shifts after applying filters.",
    ],
    bestFor: [
      "Understanding traffic composition quickly.",
      "Spotting script-heavy behavior.",
    ],
    gotcha: "Unknown can include mixed residual traffic.",
    powerDetail: "Use party filter to split first-party versus third-party patterns.",
  }),
  hourHeatmap: Object.freeze({
    what: "When activity clusters by hour and day.",
    how: [
      "Each cell is one hour-by-day bucket.",
      "Stronger color means more events.",
      "Look for repeating hotspots across days.",
    ],
    bestFor: [
      "Finding recurring daily patterns.",
      "Detecting off-hour spikes.",
    ],
    gotcha: "Small datasets can produce patchy heatmaps.",
    powerDetail: "Longer ranges usually reveal more stable time patterns.",
  }),
});

const FALLBACK_CHART_GUIDE = Object.freeze({
  what: "What this view answers at a high level for the current scope.",
  how: [
    "Read axes and labels first.",
    "Compare relative size and trend across marks.",
  ],
  bestFor: ["Quick orientation before deeper evidence review."],
});

export function getChartGuideByViewId(viewId) {
  const id = String(viewId || "");
  return CHART_GUIDE_BY_VIEW_ID[id] || FALLBACK_CHART_GUIDE;
}
