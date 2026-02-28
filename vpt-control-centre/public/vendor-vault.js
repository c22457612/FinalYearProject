function qs(id) {
  return document.getElementById(id);
}

const CATEGORY_MEANINGS = {
  session_tokens: {
    label: "Session/auth token",
    description: "A key name suggesting session or authentication state.",
    concern: "Session-linked metadata can increase account linkage risk when observed leaving the browser.",
  },
  analytics_ids: {
    label: "Analytics identifier",
    description: "A key name commonly used for analytics attribution.",
    concern: "Persistent analytics identifiers can connect visits over time.",
  },
  advertising_ids: {
    label: "Advertising identifier",
    description: "A key name associated with ad attribution or campaign tracking.",
    concern: "Advertising identifiers can support profiling and audience segmentation.",
  },
  contact_like: {
    label: "Contact-like field",
    description: "A key name that looks like contact information (for example email/phone).",
    concern: "Contact-like fields can increase re-identification risk in outbound requests.",
  },
  location_like: {
    label: "Location-like field",
    description: "A key name that suggests location coordinates or geo metadata.",
    concern: "Location-like fields can reveal sensitive area or movement context.",
  },
  identifiers: {
    label: "Online identifier (generic)",
    description: "A broad identifier-style key that may be config-linked or user-linked depending on endpoint context.",
    concern: "Generic identifiers can still enable cross-request linking.",
  },
};

// EXPOSURE-UX-2 per-item weights (deterministic, UI-only scoring).
const ITEM_CATEGORY_WEIGHTS = {
  contact_like: 35,
  session_tokens: 30,
  location_like: 25,
  advertising_ids: 20,
  analytics_ids: 15,
  identifiers: 12,
};

const DEFAULT_ITEM_CATEGORY_WEIGHT = 12;

// EXPOSURE-UX-2 deterministic evidence factors.
const EVIDENCE_FACTORS = {
  observed: 1.0,
  attempted: 0.3,
  unknown: 0.6,
};

// Keep overall vendor score display behavior consistent with prior EXPOSURE-2 implementation.
const OVERALL_CATEGORY_WEIGHTS = {
  session_tokens: 24,
  analytics_ids: 16,
  advertising_ids: 20,
  contact_like: 18,
  location_like: 17,
  identifiers: 14,
};

const DEFAULT_OVERALL_CATEGORY_WEIGHT = 10;

const KEY_HINT_RULES = [
  {
    test: (key) => key === "gclid",
    meaning: "Google Ads click identifier used for attribution context.",
    confidence: "high",
  },
  {
    test: (key) => key === "cid" || key === "client_id" || key === "clientid",
    meaning: "Client/analytics identifier that can link repeat visits or events.",
    confidence: "high",
  },
  {
    test: (key) => key === "uid" || key === "user_id" || key === "userid",
    meaning: "User-linked identifier key pattern.",
    confidence: "med",
  },
  {
    test: (key) => key === "session" || key.includes("session"),
    meaning: "Session context key that may link activity within or across sessions.",
    confidence: "med",
  },
  {
    test: (key) => key === "token" || key.includes("token"),
    meaning: "Token-style key often used for auth/session/API context.",
    confidence: "med",
  },
  {
    test: (key) => key === "email" || key.includes("email"),
    meaning: "Email-like key name inferred from captured metadata.",
    confidence: "high",
  },
  {
    test: (key) => key === "phone" || key.includes("phone"),
    meaning: "Phone-like key name inferred from captured metadata.",
    confidence: "high",
  },
  {
    test: (key) => key === "lat" || key === "latitude",
    meaning: "Latitude-like key name suggesting location context.",
    confidence: "high",
  },
  {
    test: (key) => key === "lon" || key === "lng" || key === "longitude",
    meaning: "Longitude-like key name suggesting location context.",
    confidence: "high",
  },
  {
    test: (key) => key === "id",
    meaning: "This key can be a tag/config ID or a user-linked identifier depending on endpoint context.",
    confidence: "low",
  },
];

let latestExposureRequestId = 0;

function buildSiteInsightsHref(site) {
  return `/site.html?site=${encodeURIComponent(site)}`;
}

function createLink(text, href) {
  const link = document.createElement("a");
  link.className = "viz-nav";
  link.style.textDecoration = "none";
  link.href = href;
  link.textContent = text;
  return link;
}

function showMissingState(site) {
  const missing = qs("vaultMissingState");
  const content = qs("vaultContent");
  const sections = qs("vaultSections");
  const links = qs("vaultMissingLinks");
  if (!missing || !content || !sections || !links) return;

  missing.classList.remove("hidden");
  content.classList.add("hidden");
  sections.classList.add("hidden");
  links.innerHTML = "";

  links.appendChild(createLink("Back to Control Centre", "/"));
  if (site) {
    links.appendChild(createLink("Back to Site Insights", buildSiteInsightsHref(site)));
  }
}

function showVaultContent(site, vendor) {
  const missing = qs("vaultMissingState");
  const content = qs("vaultContent");
  const sections = qs("vaultSections");
  const siteChip = qs("vaultSiteChip");
  const vendorChip = qs("vaultVendorChip");
  const backLink = qs("backToSiteInsightsLink");
  if (!missing || !content || !sections || !siteChip || !vendorChip || !backLink) return;

  missing.classList.add("hidden");
  content.classList.remove("hidden");
  sections.classList.remove("hidden");

  siteChip.textContent = `Site: ${site}`;
  vendorChip.textContent = `Vendor: ${vendor}`;
  backLink.href = buildSiteInsightsHref(site);
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function toSafeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function formatDateTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatConfidence(confidence) {
  return `${Math.round(clamp01(confidence) * 100)}%`;
}

function titleCaseFromSnake(value) {
  return String(value || "unknown")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getCategoryMeaning(categoryId) {
  const key = String(categoryId || "").trim();
  const fromMap = CATEGORY_MEANINGS[key];
  if (fromMap) return fromMap;
  return {
    label: titleCaseFromSnake(key || "unknown"),
    description: "Meaning is uncertain from captured key names alone.",
    concern: "Potential impact is uncertain for this key pattern.",
  };
}

function normalizeKeyName(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/\[\]$/g, "")
    .replace(/\s+/g, "_");
}

function getKeyHint(exampleKey) {
  const normalized = normalizeKeyName(exampleKey);
  for (const rule of KEY_HINT_RULES) {
    if (rule.test(normalized)) {
      return {
        meaning: rule.meaning,
        confidence: rule.confidence,
      };
    }
  }
  return {
    meaning: "Meaning is uncertain from key name alone; endpoint context matters.",
    confidence: "low",
  };
}

function getOverallScoreBand(score) {
  if (score >= 67) return "High";
  if (score >= 34) return "Medium";
  return "Low";
}

function getItemScoreBand(score) {
  if (score >= 60) return "High";
  if (score >= 25) return "Medium";
  return "Low";
}

function getEvidenceCounts(row) {
  const levels = row && typeof row.evidence_levels === "object" ? row.evidence_levels : {};
  const observed = toSafeCount(levels.observed);
  const attempted = toSafeCount(levels.attempted);
  const unknown = toSafeCount(levels.unknown);
  const total = observed + attempted + unknown;
  if (total > 0) return { observed, attempted, unknown, total };
  const fallbackCount = toSafeCount(row && row.count);
  return { observed: 0, attempted: 0, unknown: fallbackCount, total: fallbackCount };
}

function computeOverallRowContribution(row) {
  const categoryId = String(row && row.data_category ? row.data_category : "");
  const categoryWeight = OVERALL_CATEGORY_WEIGHTS[categoryId] || DEFAULT_OVERALL_CATEGORY_WEIGHT;
  const confidence = clamp01(row && row.confidence);
  const counts = getEvidenceCounts(row);
  const denominator = Math.max(1, counts.total || toSafeCount(row && row.count));
  const evidenceFactor = (
    (counts.observed * EVIDENCE_FACTORS.observed) +
    (counts.attempted * EVIDENCE_FACTORS.attempted) +
    (counts.unknown * EVIDENCE_FACTORS.unknown)
  ) / denominator;
  const contribution = categoryWeight * confidence * evidenceFactor;
  return Number.isFinite(contribution) ? contribution : 0;
}

function computeExposureScore(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  let total = 0;
  for (const row of safeRows) total += computeOverallRowContribution(row);
  const score = Math.max(0, Math.min(100, Math.round(total)));
  return { score, band: getOverallScoreBand(score) };
}

function computeItemScore(row) {
  const categoryId = String(row && row.data_category ? row.data_category : "");
  const weight = ITEM_CATEGORY_WEIGHTS[categoryId] || DEFAULT_ITEM_CATEGORY_WEIGHT;
  const confidence = clamp01(row && row.confidence);
  const counts = getEvidenceCounts(row);
  const countTotal = Math.max(1, counts.total);
  const evidenceFactor = (
    (counts.observed * EVIDENCE_FACTORS.observed) +
    (counts.attempted * EVIDENCE_FACTORS.attempted) +
    (counts.unknown * EVIDENCE_FACTORS.unknown)
  ) / countTotal;
  const raw = confidence * weight * evidenceFactor;
  const itemScore = Math.max(0, Math.min(100, Math.round(raw)));
  return {
    itemScore,
    itemBand: getItemScoreBand(itemScore),
    weight,
    confidencePct: Math.round(confidence * 100),
    evidenceFactor,
  };
}

function getItemStatus(counts) {
  return counts.observed > 0 ? "Observed" : "Attempted";
}

function getItemScenario(counts) {
  if (counts.observed > 0) return "observed";
  if (counts.attempted > 0) return "attempted_only";
  return "unknown";
}

function makeOpenInSiteInsightsAction(site, vendor) {
  const guidanceVendor = String(vendor || "").trim();
  return {
    key: "open_site_insights",
    text: "Open in Site Insights",
    href: buildSiteInsightsHref(site),
    guidance: guidanceVendor ? `Then select ${guidanceVendor} in vendor focus.` : "Then select this vendor in vendor focus.",
  };
}

function getCategorySpecificAction(categoryId, scenario) {
  if (categoryId === "identifiers" && scenario === "observed") {
    return { key: "identifiers_observed", text: "Identifiers can enable cross-site linking; keep Strict mode enabled." };
  }
  if (categoryId === "identifiers" && scenario === "attempted_only") {
    return { key: "identifiers_attempted", text: "Blocked identifier attempts suggest tracking intent; keep protections enabled." };
  }
  if (categoryId === "analytics_ids" && scenario === "observed") {
    return { key: "analytics_observed", text: "Analytics identifiers can persist across visits; consider privacy mode for this site." };
  }
  if (categoryId === "advertising_ids" && scenario === "observed") {
    return { key: "advertising_observed", text: "Advertising identifiers can be used for profiling; consider limiting ad scripts on this site." };
  }
  if (categoryId === "contact_like" && scenario === "observed") {
    return { key: "contact_observed", text: "Avoid entering email/phone into embedded widgets; consider using an alias." };
  }
  if (categoryId === "location_like" && scenario === "observed") {
    return { key: "location_observed", text: "Disable location permission for this site (if enabled) and avoid sharing precise location." };
  }
  if (categoryId === "session_tokens" && scenario === "observed") {
    return { key: "session_observed", text: "Tokens relate to login/session state; log out when finished and avoid reusing sessions." };
  }
  return null;
}

function mapSuggestedActions({ categoryId, scenario, observed, attempted, site, vendor }) {
  const actions = [makeOpenInSiteInsightsAction(site, vendor)];

  let primaryScenarioAction = null;
  let secondaryScenarioAction = null;
  if (scenario === "attempted_only" || (observed === 0 && attempted > 0)) {
    primaryScenarioAction = {
      key: "attempted_strict_mode",
      text: "Keep Strict mode enabled to continue blocking attempts.",
    };
    secondaryScenarioAction = {
      key: "attempted_monitor_again",
      text: "Monitor again after browsing (attempts can vary by page).",
    };
  } else if (scenario === "observed" || observed > 0) {
    primaryScenarioAction = {
      key: "observed_clear_site_data",
      text: "Consider clearing site data (cookies/storage) after using this site.",
    };
    secondaryScenarioAction = {
      key: "observed_limit_third_party",
      text: "Consider limiting third-party scripts/trackers on this site.",
    };
  }
  if (primaryScenarioAction) actions.push(primaryScenarioAction);

  const categoryAction = getCategorySpecificAction(categoryId, scenario);
  if (categoryAction) actions.push(categoryAction);
  else if (secondaryScenarioAction) actions.push(secondaryScenarioAction);

  const deduped = [];
  const seen = new Set();
  for (const action of actions) {
    const key = String(action && action.key ? action.key : action && action.text ? action.text : "");
    if (!key || seen.has(key)) continue;
    deduped.push(action);
    seen.add(key);
  }
  return deduped.slice(0, 3);
}

function getUncertaintyLine(item) {
  if (item.scenario === "observed") {
    return "Some signals were observed leaving the browser, so the vendor may have received this type.";
  }
  if (item.scenario === "attempted_only") {
    return "Only blocked attempts were detected for this item; attempted (blocked) is not proof of receipt.";
  }
  return "Signals are uncertain for this item and should be treated as potential exposure only.";
}

function buildItemModel(row, index, site, vendor) {
  const categoryId = String(row && row.data_category ? row.data_category : "");
  const meaning = getCategoryMeaning(categoryId);
  const counts = getEvidenceCounts(row);
  const exampleKey = String((row && row.example_key) || "-");
  const keyHint = getKeyHint(exampleKey);
  const scenario = getItemScenario(counts);
  const itemScoreMeta = computeItemScore(row);
  const actions = mapSuggestedActions({
    categoryId,
    scenario,
    observed: counts.observed,
    attempted: counts.attempted,
    site,
    vendor,
  });

  const privacyBullets = [
    meaning.concern,
    scenario === "attempted_only"
      ? "Blocked attempts still indicate intent to transmit similar keys on some pages."
      : "Observed requests indicate this category may have left the browser in this scope.",
  ];

  return {
    index,
    categoryLabel: meaning.label,
    categoryDescription: meaning.description,
    keyHint,
    counts,
    scenario,
    statusLabel: getItemStatus(counts),
    itemScoreMeta,
    exampleKey,
    count: toSafeCount(row && row.count),
    firstSeen: formatDateTime(row && row.first_seen),
    lastSeen: formatDateTime(row && row.last_seen),
    confidenceText: formatConfidence(row && row.confidence),
    actions,
    privacyBullets,
    uncertaintyLine: getUncertaintyLine({ scenario }),
  };
}

function formatCategorySet(set, emptyText) {
  const labels = Array.from(set.values()).sort((a, b) => a.localeCompare(b));
  if (!labels.length) return emptyText;
  return labels.join(", ");
}

function toBandShortLabel(band) {
  if (band === "Medium") return "Med";
  if (band === "High") return "High";
  if (band === "Low") return "Low";
  return "-";
}

function renderSummaryRing(score) {
  const ring = qs("exposureSummaryScoreRing");
  const visual = document.querySelector(".vendor-vault-score-visual");
  if (!ring) return;

  const radius = Number(ring.getAttribute("r")) || 44;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, Number(score) || 0));
  const normalized = clamped / 100;

  ring.style.strokeDasharray = `${circumference} ${circumference}`;
  ring.style.strokeDashoffset = `${circumference * (1 - normalized)}`;

  if (visual) {
    visual.classList.remove("is-low", "is-medium", "is-high");
    if (clamped >= 67) visual.classList.add("is-high");
    else if (clamped >= 34) visual.classList.add("is-medium");
    else visual.classList.add("is-low");
  }
}

function renderActionList(listEl, actions) {
  if (!listEl) return;
  listEl.innerHTML = "";

  const safeActions = Array.isArray(actions) ? actions : [];
  for (const action of safeActions) {
    const li = document.createElement("li");
    if (action.href) {
      const link = document.createElement("a");
      link.href = action.href;
      link.textContent = action.text;
      link.className = "vendor-vault-action-link";
      li.appendChild(link);
      if (action.guidance) {
        const guidance = document.createElement("span");
        guidance.className = "vendor-vault-action-guidance";
        guidance.textContent = ` ${action.guidance}`;
        li.appendChild(guidance);
      }
    } else {
      li.textContent = action.text;
    }
    listEl.appendChild(li);
  }
}

function deriveVendorActions(itemModels) {
  const topTwo = itemModels
    .slice()
    .sort((a, b) => (
      (b.itemScoreMeta.itemScore - a.itemScoreMeta.itemScore) ||
      a.categoryLabel.localeCompare(b.categoryLabel)
    ))
    .slice(0, 2);

  const actions = [];
  const seen = new Set();
  for (const item of topTwo) {
    for (const action of item.actions) {
      const key = String(action && action.key ? action.key : action && action.text ? action.text : "");
      if (!key || seen.has(key)) continue;
      actions.push(action);
      seen.add(key);
      if (actions.length >= 3) return actions;
    }
  }
  return actions.slice(0, 3);
}

function renderSummary(scoreMeta, itemModels) {
  const scoreTextEl = qs("exposureSummaryScoreText");
  const scoreValueEl = qs("exposureSummaryScoreValue");
  const scoreBandEl = qs("exposureSummaryScoreBand");
  const mayList = qs("exposureMayHaveReceivedList");
  const attemptedList = qs("exposureAttemptedToReceiveList");
  const vendorActionsList = qs("exposureVendorActionsList");
  if (!scoreTextEl || !scoreValueEl || !scoreBandEl || !mayList || !attemptedList || !vendorActionsList) return;

  if (!scoreMeta) {
    scoreTextEl.textContent = "Exposure score: -";
    scoreValueEl.textContent = "-";
    scoreBandEl.textContent = "-";
    renderSummaryRing(0);
  } else {
    scoreTextEl.textContent = `Exposure score: ${scoreMeta.score} (${scoreMeta.band})`;
    scoreValueEl.textContent = String(scoreMeta.score);
    scoreBandEl.textContent = toBandShortLabel(scoreMeta.band);
    renderSummaryRing(scoreMeta.score);
  }

  const observedCategories = new Set();
  const attemptedCategories = new Set();
  for (const item of itemModels) {
    if (item.counts.observed > 0) observedCategories.add(item.categoryLabel);
    if (item.counts.attempted > 0) attemptedCategories.add(item.categoryLabel);
  }

  mayList.textContent = formatCategorySet(observedCategories, "None observed");
  attemptedList.textContent = formatCategorySet(attemptedCategories, "None detected");
  renderActionList(vendorActionsList, deriveVendorActions(itemModels));
}

function createDetailSection(title) {
  const section = document.createElement("section");
  section.className = "vendor-vault-entry-section";

  const heading = document.createElement("h4");
  heading.className = "vendor-vault-entry-section-title";
  heading.textContent = title;
  section.appendChild(heading);

  return section;
}

function appendBulletList(section, bullets, listClassName) {
  const list = document.createElement("ul");
  list.className = listClassName;
  for (const bullet of bullets) {
    const li = document.createElement("li");
    li.textContent = bullet;
    list.appendChild(li);
  }
  section.appendChild(list);
}

function renderInventoryEntries(itemModels) {
  const list = qs("exposureInventoryList");
  if (!list) return;
  list.innerHTML = "";

  const sortedItems = itemModels
    .slice()
    .sort((a, b) => (
      (b.itemScoreMeta.itemScore - a.itemScoreMeta.itemScore) ||
      (b.count - a.count) ||
      a.categoryLabel.localeCompare(b.categoryLabel)
    ));

  for (const item of sortedItems) {
    const card = document.createElement("details");
    card.className = "vendor-vault-entry";
    card.setAttribute("role", "listitem");

    const summary = document.createElement("summary");
    summary.className = "vendor-vault-row-summary";

    const rowMain = document.createElement("div");
    rowMain.className = "vendor-vault-row-main";

    const head = document.createElement("div");
    head.className = "vendor-vault-entry-title-row";

    const title = document.createElement("span");
    title.className = "vendor-vault-entry-title";
    title.textContent = item.categoryLabel;
    head.appendChild(title);

    const statusPill = document.createElement("span");
    statusPill.className = `vendor-vault-status-pill vendor-vault-status-${item.statusLabel.toLowerCase()}`;
    statusPill.textContent = item.statusLabel;
    head.appendChild(statusPill);

    const scorePill = document.createElement("span");
    scorePill.className = `vendor-vault-score-pill vendor-vault-band-${String(item.itemScoreMeta.itemBand).toLowerCase()}`;
    scorePill.textContent = `Score ${item.itemScoreMeta.itemScore} (${item.itemScoreMeta.itemBand})`;
    head.appendChild(scorePill);

    rowMain.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "vendor-vault-entry-meta";
    meta.textContent = `Count: ${item.count} | Last seen: ${item.lastSeen}`;
    rowMain.appendChild(meta);

    summary.appendChild(rowMain);

    const chevron = document.createElement("span");
    chevron.className = "vendor-vault-row-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = ">";
    summary.appendChild(chevron);

    const panel = document.createElement("div");
    panel.className = "vendor-vault-entry-panel";
    panel.id = `vault-entry-panel-${item.index}`;
    summary.setAttribute("aria-controls", panel.id);

    const potentialSection = createDetailSection("Potential data");
    appendBulletList(
      potentialSection,
      [
        `Potentially shared category: ${item.categoryLabel}. ${item.categoryDescription}`,
        `Key observed: ${item.exampleKey}. ${item.keyHint.meaning} (key-hint confidence: ${item.keyHint.confidence}).`,
        `Uncertainty: ${item.uncertaintyLine}`,
      ],
      "vendor-vault-detail-list"
    );
    panel.appendChild(potentialSection);

    const whySection = createDetailSection("Why it matters");
    appendBulletList(whySection, item.privacyBullets, "vendor-vault-detail-list");
    panel.appendChild(whySection);

    const actionsSection = createDetailSection("Suggested actions");
    const actionsList = document.createElement("ul");
    actionsList.className = "vendor-vault-action-list";
    renderActionList(actionsList, item.actions);
    actionsSection.appendChild(actionsList);
    panel.appendChild(actionsSection);

    const evidenceSection = createDetailSection("Evidence summary");
    appendBulletList(
      evidenceSection,
      [
        `Observed: ${item.counts.observed} | Attempted (blocked): ${item.counts.attempted} | Unknown: ${item.counts.unknown}`,
        `First seen: ${item.firstSeen} | Last seen: ${item.lastSeen}`,
        `Confidence (key-based): ${item.confidenceText}`,
        "Attempted (blocked) is not proof of receipt.",
      ],
      "vendor-vault-evidence-list"
    );
    panel.appendChild(evidenceSection);

    const scoreSection = createDetailSection("How the score was calculated");
    appendBulletList(
      scoreSection,
      [
        `Item score: ${item.itemScoreMeta.itemScore} (${item.itemScoreMeta.itemBand})`,
        `Category weight: ${item.itemScoreMeta.weight}`,
        `Confidence factor: ${item.itemScoreMeta.confidencePct}%`,
        `Evidence factor: ${item.itemScoreMeta.evidenceFactor.toFixed(2)} (observed=1.0, attempted=0.3, unknown=0.6)`,
      ],
      "vendor-vault-detail-list"
    );
    panel.appendChild(scoreSection);

    card.appendChild(summary);
    card.appendChild(panel);
    list.appendChild(card);
  }
}

function setInventoryState(state) {
  const loading = qs("exposureLoadingState");
  const error = qs("exposureErrorState");
  const empty = qs("exposureEmptyState");
  const success = qs("exposureSuccessState");
  if (!loading || !error || !empty || !success) return;

  loading.classList.toggle("hidden", state !== "loading");
  error.classList.toggle("hidden", state !== "error");
  empty.classList.toggle("hidden", state !== "empty");
  success.classList.toggle("hidden", state !== "success");
}

function clearSuccessContent() {
  renderSummary(null, []);
  renderInventoryEntries([]);
}

function setLoadingView() {
  setInventoryState("loading");
  clearSuccessContent();
}

async function loadExposureInventory(site, vendor) {
  const requestId = ++latestExposureRequestId;
  setLoadingView();

  try {
    const response = await fetch(
      `/api/exposure-inventory?site=${encodeURIComponent(site)}&vendor=${encodeURIComponent(vendor)}`
    );
    if (!response.ok) throw new Error(`inventory_request_failed_${response.status}`);

    const payload = await response.json();
    if (requestId !== latestExposureRequestId) return;

    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    const scoreMeta = computeExposureScore(rows);
    const itemModels = rows.map((row, index) => buildItemModel(row, index, site, vendor));

    renderSummary(scoreMeta, itemModels);

    if (!rows.length) {
      setInventoryState("empty");
      return;
    }

    renderInventoryEntries(itemModels);
    setInventoryState("success");
  } catch (err) {
    if (requestId !== latestExposureRequestId) return;
    console.error("Vendor Vault inventory fetch failed:", err);
    setInventoryState("error");
  }
}

function bootVendorVault() {
  const params = new URLSearchParams(window.location.search);
  const site = String(params.get("site") || "").trim();
  const vendor = String(params.get("vendor") || "").trim();

  if (!site || !vendor) {
    showMissingState(site);
    return;
  }

  showVaultContent(site, vendor);

  const retryButton = qs("exposureRetryButton");
  if (retryButton) {
    retryButton.addEventListener("click", () => {
      loadExposureInventory(site, vendor);
    });
  }

  loadExposureInventory(site, vendor);
}

window.addEventListener("load", bootVendorVault);
