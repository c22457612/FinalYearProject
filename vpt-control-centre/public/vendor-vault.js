function qs(id) {
  return document.getElementById(id);
}

const CATEGORY_MEANINGS = {
  session_tokens: {
    label: "Session/auth token",
    description: "A key name suggesting session or authentication state. It may represent account continuity or anti-forgery context.",
  },
  analytics_ids: {
    label: "Analytics identifier",
    description: "A key name commonly used for analytics attribution. It can be used to connect repeat activity to a browser or device.",
  },
  advertising_ids: {
    label: "Advertising identifier",
    description: "A key name associated with ad attribution or campaign tracking. It may be used to measure ad interactions across visits.",
  },
  contact_like: {
    label: "Contact-like field",
    description: "A key name that looks like contact information (for example email/phone). This inference is based on key names only.",
  },
  location_like: {
    label: "Location-like field",
    description: "A key name that suggests location coordinates or geo metadata. This indicates potential location context from captured signals.",
  },
  identifiers: {
    label: "Online identifier (generic)",
    description: "A broad identifier-style key. It can be a user-linked identifier or an internal/config tag depending on endpoint context.",
  },
};

const CATEGORY_WEIGHTS = {
  session_tokens: 24,
  analytics_ids: 16,
  advertising_ids: 20,
  contact_like: 18,
  location_like: 17,
  identifiers: 14,
};

const DEFAULT_CATEGORY_WEIGHT = 10;

const KEY_HINT_RULES = [
  {
    test: (key) => key === "gclid",
    meaning: "Google Ads click identifier used for ad attribution.",
    confidence: "high",
  },
  {
    test: (key) => key === "cid" || key === "client_id" || key === "clientid",
    meaning: "Client or analytics identifier linking repeat visits/events.",
    confidence: "high",
  },
  {
    test: (key) => key === "uid" || key === "user_id" || key === "userid",
    meaning: "User-linked identifier key pattern.",
    confidence: "med",
  },
  {
    test: (key) => key === "session" || key.includes("session"),
    meaning: "Session context key that may link activity in one browsing session.",
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
    meaning: "Ambiguous key: could be a tag/config ID or a user-linked ID depending on endpoint.",
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
  };
}

function formatDataCategory(categoryId) {
  return getCategoryMeaning(categoryId).label;
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

function getScoreBand(score) {
  // Thresholds: 0-33 Low, 34-66 Medium, 67-100 High.
  if (score >= 67) return "High";
  if (score >= 34) return "Medium";
  return "Low";
}

function getEvidenceCounts(row) {
  const levels = row && typeof row.evidence_levels === "object" ? row.evidence_levels : {};
  const observed = toSafeCount(levels.observed);
  const attempted = toSafeCount(levels.attempted);
  const unknown = toSafeCount(levels.unknown);
  const total = observed + attempted + unknown;
  if (total > 0) {
    return { observed, attempted, unknown, total };
  }
  const fallbackCount = toSafeCount(row && row.count);
  return { observed: 0, attempted: 0, unknown: fallbackCount, total: fallbackCount };
}

function summarizeEvidenceLevel(row) {
  const counts = getEvidenceCounts(row);
  if (counts.total <= 0) return "Unknown";

  let label = "Unknown";
  let dominant = counts.unknown;

  if (counts.observed >= counts.attempted && counts.observed >= counts.unknown && counts.observed > 0) {
    label = "Observed";
    dominant = counts.observed;
  } else if (counts.attempted >= counts.unknown && counts.attempted > 0) {
    label = "Attempted";
    dominant = counts.attempted;
  }

  return `${label} (${dominant}/${counts.total})`;
}

function computeRowContribution(row) {
  const categoryId = String(row && row.data_category ? row.data_category : "");
  const categoryWeight = CATEGORY_WEIGHTS[categoryId] || DEFAULT_CATEGORY_WEIGHT;
  const confidence = clamp01(row && row.confidence);
  const counts = getEvidenceCounts(row);
  const denominator = Math.max(1, counts.total || toSafeCount(row && row.count));
  const evidenceFactor = (
    (counts.observed * 1.0) +
    (counts.attempted * 0.3) +
    (counts.unknown * 0.6)
  ) / denominator;
  const contribution = categoryWeight * confidence * evidenceFactor;

  return {
    categoryId,
    categoryLabel: formatDataCategory(categoryId),
    contribution: Number.isFinite(contribution) ? contribution : 0,
  };
}

function computeExposureScore(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const categoryContribution = new Map();
  let total = 0;

  for (const row of safeRows) {
    const item = computeRowContribution(row);
    total += item.contribution;
    categoryContribution.set(
      item.categoryLabel,
      (categoryContribution.get(item.categoryLabel) || 0) + item.contribution
    );
  }

  const score = Math.max(0, Math.min(100, Math.round(total)));
  const band = getScoreBand(score);
  const topContributors = Array.from(categoryContribution.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([categoryLabel, contribution]) => ({
      categoryLabel,
      contribution: Number(contribution.toFixed(1)),
    }));

  return { score, band, topContributors };
}

function formatCategorySet(set, emptyText) {
  const labels = Array.from(set.values()).sort((a, b) => a.localeCompare(b));
  if (!labels.length) return emptyText;
  return labels.join(", ");
}

function renderSharingSummary(rows) {
  const mayList = qs("exposureMayHaveReceivedList");
  const attemptedList = qs("exposureAttemptedToShareList");
  const attemptedOnlyNote = qs("exposureAttemptedOnlyNote");
  if (!mayList || !attemptedList || !attemptedOnlyNote) return;

  const observedCategories = new Set();
  const attemptedCategories = new Set();

  for (const row of rows) {
    const counts = getEvidenceCounts(row);
    const categoryLabel = formatDataCategory(row && row.data_category);
    if (counts.observed > 0) observedCategories.add(categoryLabel);
    if (counts.attempted > 0) attemptedCategories.add(categoryLabel);
  }

  mayList.textContent = formatCategorySet(observedCategories, "None observed from captured signals.");
  attemptedList.textContent = formatCategorySet(attemptedCategories, "No blocked attempts observed.");

  const isAttemptedOnly = observedCategories.size === 0 && attemptedCategories.size > 0;
  attemptedOnlyNote.classList.toggle("hidden", !isAttemptedOnly);
}

function setInventoryState(state) {
  const loading = qs("exposureLoadingState");
  const error = qs("exposureErrorState");
  const empty = qs("exposureEmptyState");
  const success = qs("exposureSuccessState");
  const explainDetails = qs("exposureExplainDetails");
  if (!loading || !error || !empty || !success || !explainDetails) return;

  loading.classList.toggle("hidden", state !== "loading");
  error.classList.toggle("hidden", state !== "error");
  empty.classList.toggle("hidden", state !== "empty");
  success.classList.toggle("hidden", state !== "success");
  explainDetails.classList.toggle("hidden", !(state === "empty" || state === "success"));
}

function renderScore(scoreMeta) {
  const line = qs("exposureScoreLine");
  if (!line) return;

  if (!scoreMeta) {
    line.textContent = "Exposure score: -";
    return;
  }

  line.textContent = `Exposure score: ${scoreMeta.score} (${scoreMeta.band})`;
}

function renderExplain(scoreMeta, rows) {
  const contributionList = qs("exposureTopContributors");
  const keyMeaningList = qs("exposureKeyMeaningList");
  const explain = qs("exposureExplainDetails");
  if (!contributionList || !keyMeaningList || !explain) return;

  contributionList.innerHTML = "";
  keyMeaningList.innerHTML = "";

  const contributors = scoreMeta && Array.isArray(scoreMeta.topContributors)
    ? scoreMeta.topContributors
    : [];

  if (!contributors.length) {
    const li = document.createElement("li");
    li.textContent = "No contributing categories observed in this scope.";
    contributionList.appendChild(li);
  } else {
    for (const contributor of contributors) {
      const li = document.createElement("li");
      li.textContent = `${contributor.categoryLabel}: ${contributor.contribution} points`;
      contributionList.appendChild(li);
    }
  }

  const rankedRows = Array.isArray(rows)
    ? rows
      .map((row) => ({
        row,
        contribution: computeRowContribution(row).contribution,
      }))
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 3)
    : [];

  if (!rankedRows.length) {
    const li = document.createElement("li");
    li.textContent = "No key hints available for this scope.";
    keyMeaningList.appendChild(li);
  } else {
    for (const item of rankedRows) {
      const row = item.row || {};
      const exampleKey = String(row.example_key || "-");
      const keyHint = getKeyHint(exampleKey);
      const li = document.createElement("li");
      li.textContent = `Key observed: ${exampleKey} - ${keyHint.meaning} (confidence: ${keyHint.confidence}).`;
      keyMeaningList.appendChild(li);
    }
  }

  explain.open = false;
}

function buildRowMeaningText(row) {
  const category = getCategoryMeaning(row && row.data_category);
  const exampleKey = String((row && row.example_key) || "-");
  const keyHint = getKeyHint(exampleKey);
  return {
    categoryDescription: category.description,
    keyLine: `Key observed: ${exampleKey} - ${keyHint.meaning} (confidence: ${keyHint.confidence}).`,
  };
}

function createMeaningDetails(row) {
  const detail = buildRowMeaningText(row);
  const wrapper = document.createElement("details");
  wrapper.className = "vendor-vault-row-meaning";

  const summary = document.createElement("summary");
  summary.textContent = "What this means";
  wrapper.appendChild(summary);

  const body = document.createElement("div");
  body.className = "vendor-vault-row-meaning-body";

  const description = document.createElement("div");
  description.textContent = detail.categoryDescription;
  body.appendChild(description);

  const keyLine = document.createElement("div");
  keyLine.className = "vendor-vault-row-meaning-key";
  keyLine.textContent = detail.keyLine;
  body.appendChild(keyLine);

  const attemptedNote = document.createElement("div");
  attemptedNote.className = "vendor-vault-row-meaning-note";
  attemptedNote.textContent = "Attempted indicates blocked transmission and is not proof of vendor receipt.";
  body.appendChild(attemptedNote);

  wrapper.appendChild(body);
  return wrapper;
}

function renderInventoryRows(rows) {
  const body = qs("exposureInventoryBody");
  if (!body) return;
  body.innerHTML = "";

  for (const row of rows) {
    const tr = document.createElement("tr");
    const count = toSafeCount(row.count);

    const cells = [
      formatDataCategory(row.data_category),
      summarizeEvidenceLevel(row),
      String(count),
      formatDateTime(row.first_seen),
      formatDateTime(row.last_seen),
      formatConfidence(row.confidence),
      String(row.example_key || "-"),
    ];

    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }

    const meaningTd = document.createElement("td");
    meaningTd.appendChild(createMeaningDetails(row));
    tr.appendChild(meaningTd);

    body.appendChild(tr);
  }
}

function clearSuccessContent() {
  renderSharingSummary([]);
  renderInventoryRows([]);
}

function setLoadingView() {
  setInventoryState("loading");
  renderScore(null);
  renderExplain(null, []);
  clearSuccessContent();
}

async function loadExposureInventory(site, vendor) {
  const requestId = ++latestExposureRequestId;
  setLoadingView();

  try {
    const response = await fetch(
      `/api/exposure-inventory?site=${encodeURIComponent(site)}&vendor=${encodeURIComponent(vendor)}`
    );
    if (!response.ok) {
      throw new Error(`inventory_request_failed_${response.status}`);
    }

    const payload = await response.json();
    if (requestId !== latestExposureRequestId) return;

    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    const scoreMeta = computeExposureScore(rows);
    renderScore(scoreMeta);
    renderExplain(scoreMeta, rows);

    if (!rows.length) {
      setInventoryState("empty");
      return;
    }

    renderSharingSummary(rows);
    renderInventoryRows(rows);
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
