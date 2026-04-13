import { getApiEventPresentation, isApiSignalEvent } from "../../api-event-presentation.js";
import { buildSiteBrowserApiNarrative } from "../../browser-api-narratives.js";
import { getEventListContextText, getEventListKindText, getEventListMetaText } from "../utils.js";
import { summarizeVisualCategoryCounts } from "../filter-state.js";

function splitInsightLeadSummary(summaryText) {
  const text = String(summaryText || "").trim().replace(/\s+/g, " ");
  if (!text) {
    return {
      headline: "",
      detail: "",
    };
  }

  const match = text.match(/^(.+?[.!?])(?:\s+(.*))?$/);
  if (!match) {
    return {
      headline: text,
      detail: "",
    };
  }

  return {
    headline: String(match[1] || "").trim(),
    detail: String(match[2] || "").trim(),
  };
}

function pluralizeLeadWord(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getLeadSignalCounts(evidence) {
  const counts = {
    thirdParty: 0,
    scripts: 0,
    xhrFetch: 0,
    api: 0,
  };

  for (const ev of Array.isArray(evidence) ? evidence : []) {
    if (ev?.data?.isThirdParty === true) counts.thirdParty += 1;

    const resourceType = String(ev?.data?.resourceType || "").toLowerCase();
    if (resourceType.includes("script")) counts.scripts += 1;
    if (
      resourceType.includes("xhr")
      || resourceType.includes("fetch")
      || resourceType.includes("xmlhttprequest")
    ) {
      counts.xhrFetch += 1;
    }

    if (isApiSignalEvent(ev)) counts.api += 1;
  }

  return counts;
}

function humanizeEasyKindLabel(kind, viewMode = "power") {
  const raw = String(kind || "").trim();
  if (!raw) return "Activity";
  if (viewMode !== "easy") return raw;

  const normalized = raw.toLowerCase();
  if (normalized === "network.blocked") return "Network blocked";
  if (normalized === "network.observed") return "Network observed";
  if (normalized === "cookies.snapshot") return "Cookie activity";
  if (normalized === "cookies.cleared" || normalized === "cookies.removed") return "Cookie cleanup";
  if (normalized.startsWith("storage.")) return "Storage activity";
  if (normalized.startsWith("script.")) return "Script activity";
  if (normalized.includes("webrtc")) return "WebRTC activity";
  if (normalized.includes("canvas")) return "Canvas activity";
  if (normalized.includes("clipboard")) return "Clipboard activity";
  if (normalized.includes("geolocation")) return "Geolocation activity";
  if (normalized.startsWith("api.") || normalized.startsWith("browser_api.")) return "Browser API activity";
  return raw.replaceAll(".", " ");
}

function formatCategorySummary(summary, viewMode = "power") {
  const blocked = Number(summary?.blocked || 0) + Number(summary?.blockedApi || 0);
  const observed = Number(summary?.observed || 0) + Number(summary?.observedApi || 0);
  const other = Number(summary?.other || 0);
  const blockedApi = Number(summary?.blockedApi || 0);
  const observedApi = Number(summary?.observedApi || 0);

  if (viewMode === "easy") {
    const parts = [`${blocked} blocked`, `${observed} observed`];
    if (other > 0) parts.push(`${other} other`);
    return parts.join(", ");
  }

  const parts = [
    `${Number(summary?.blocked || 0)} blocked`,
    `${Number(summary?.observed || 0)} observed`,
  ];
  if (blockedApi > 0) parts.push(`${blockedApi} blocked API`);
  if (observedApi > 0) parts.push(`${observedApi} observed API`);
  if (other > 0) parts.push(`${other} other`);
  return parts.join(", ");
}

function formatDominantKinds(dominantKinds, viewMode = "power") {
  const list = Array.isArray(dominantKinds) ? dominantKinds : [];
  if (!list.length) return "-";
  return list.map((item) => `${humanizeEasyKindLabel(item?.kind, viewMode)}: ${item?.count || 0}`).join(", ");
}

export function buildInsightLeadPresentation({ insight = null, evidence = [] } = {}) {
  const summaryText = String(insight?.summary || "").trim();
  const text = splitInsightLeadSummary(summaryText);
  const evidenceSummary = insight?.evidenceSummary || {};
  const total = Number(evidenceSummary.total || (Array.isArray(evidence) ? evidence.length : 0));
  const blocked = Number(evidenceSummary.blocked || 0) + Number(evidenceSummary.blockedApi || 0);
  const observed = Number(evidenceSummary.observed || 0) + Number(evidenceSummary.observedApi || 0);
  const signalCounts = getLeadSignalCounts(evidence);

  const facts = [];
  if (total > 0) {
    facts.push({ label: "Activity", value: pluralizeLeadWord(total, "event") });
    facts.push({ label: "Outcome", value: `${blocked} blocked / ${observed} observed` });
  }
  if (signalCounts.thirdParty > 0) {
    facts.push({ label: "Exposure", value: `${signalCounts.thirdParty} third-party` });
  }
  if (signalCounts.scripts > 0) {
    facts.push({ label: "Signals", value: pluralizeLeadWord(signalCounts.scripts, "script request") });
  } else if (signalCounts.xhrFetch > 0) {
    facts.push({ label: "Signals", value: pluralizeLeadWord(signalCounts.xhrFetch, "XHR/fetch request") });
  } else if (signalCounts.api > 0) {
    facts.push({ label: "Signals", value: pluralizeLeadWord(signalCounts.api, "Browser API event") });
  }

  return {
    headline: text.headline || "No deterministic summary available for this scope.",
    detail: text.detail,
    facts: facts.slice(0, 4),
  };
}

function getConfidenceBand(percent) {
  if (percent >= 85) return "high";
  if (percent >= 60) return "moderate";
  return "low";
}

function formatSeverityLabel(severity) {
  if (severity === "high") return "High";
  if (severity === "caution") return "Caution";
  return "Info";
}

export function buildInsightCaseSheetPresentation({ insight = null, evidence = [] } = {}) {
  const summaryText = String(insight?.summary || "").trim();
  const text = splitInsightLeadSummary(summaryText);
  const evidenceSummary = insight?.evidenceSummary || {};
  const total = Number(evidenceSummary.total || (Array.isArray(evidence) ? evidence.length : 0));
  const blocked = Number(evidenceSummary.blocked || 0) + Number(evidenceSummary.blockedApi || 0);
  const observed = Number(evidenceSummary.observed || 0) + Number(evidenceSummary.observedApi || 0);
  const other = Number(evidenceSummary.other || 0);
  const signalCounts = getLeadSignalCounts(evidence);
  const percent = Math.max(0, Math.min(100, Math.round((Number(insight?.confidence || 0)) * 100)));
  const severity = insight?.severity === "high" ? "high" : insight?.severity === "caution" ? "caution" : "info";

  const metrics = [];
  if (total > 0) {
    metrics.push({ label: "Events", value: String(total), note: "captured in scope", tone: "neutral" });
    metrics.push({ label: "Blocked", value: String(blocked), note: "including API", tone: "blocked" });
    metrics.push({ label: "Observed", value: String(observed), note: "including API", tone: "observed" });
  }
  if (signalCounts.thirdParty > 0) {
    metrics.push({ label: "Third-party", value: String(signalCounts.thirdParty), note: "requests", tone: "neutral" });
  }
  if (signalCounts.scripts > 0) {
    metrics.push({ label: "Signals", value: String(signalCounts.scripts), note: "script requests", tone: "signals" });
  } else if (signalCounts.xhrFetch > 0) {
    metrics.push({ label: "Signals", value: String(signalCounts.xhrFetch), note: "XHR/fetch requests", tone: "signals" });
  } else if (signalCounts.api > 0) {
    metrics.push({ label: "Signals", value: String(signalCounts.api), note: "Browser API events", tone: "signals" });
  } else if (other > 0) {
    metrics.push({ label: "Other", value: String(other), note: "other events", tone: "neutral" });
  }

  return {
    takeaway: text.headline || "No summary generated.",
    summaryDetail: text.detail,
    severity: {
      level: severity,
      label: formatSeverityLabel(severity),
    },
    confidence: {
      percent,
      label: `${percent}% confidence`,
      band: getConfidenceBand(percent),
    },
    metrics: metrics.slice(0, 5),
    footer: {
      hasActions: Array.isArray(insight?.actions) && insight.actions.length > 0,
      hasTechnical: Array.isArray(evidence) && evidence.length > 0,
      primaryActionIndex: Array.isArray(insight?.actions) && insight.actions.length > 0 ? 0 : -1,
    },
  };
}

export function createInsightSheet(deps) {
  const {
    qs,
    friendlyTime,
    pickPrimarySelectedEvent,
    formatSelectedLead,
    triggerDownload,
    escapeCsvCell,
    getInsightRules,
    ensureInsightVisible,
    getViewMode,
    getSiteName,
    getSelectedVendor,
    getChartEvents,
    buildVendorEndpointReadoutData,
    getViews,
    getVizIndex,
  } = deps;

  let activeEvidence = [];
  let pendingConfirmAction = null;
  let activeDrawerEvent = null;

  function buildInsightView(selection, evidence) {
    const insightApi = getInsightRules();
    const evs = Array.isArray(evidence) ? evidence.filter(Boolean) : [];
    const primaryEvent = pickPrimarySelectedEvent(evs);

    const context = {
      events: evs,
      viewId: getViews()[getVizIndex()]?.id || "unknown",
      viewMode: getViewMode(),
      siteName: getSiteName(),
      selectedVendor: getSelectedVendor(),
      selectedDomain: selection?.type === "domain" ? selection.value : "",
    };

    const insight = insightApi?.buildInsightResult
      ? insightApi.buildInsightResult(context)
      : buildFallbackInsight(selection, evs);

    return {
      selection,
      evs,
      primaryEvent,
      context,
      insight,
    };
  }

  function closeDrawer() {
    const panel = qs("insightTechnicalPanel");
    panel?.classList.add("hidden");
    if (panel) panel.open = false;
    if (qs("drawerSummary")) qs("drawerSummary").innerHTML = "";
    if (qs("drawerEvents")) qs("drawerEvents").innerHTML = "";
    activeDrawerEvent = null;
    syncInsightFooterVisibility();
  }

  function explainEventAdvanced(ev) {
    if (!ev) return "";

    const d = ev.data || {};
    const enrich = ev.enrichment || {};
    const lines = [
      `id: ${ev.id || "-"}`,
      `ts: ${ev.ts ? new Date(ev.ts).toLocaleString() : "-"}`,
      `site: ${ev.site || "-"}`,
      `kind: ${ev.kind || "-"}`,
      `mode: ${ev.mode || "-"}`,
      `surface: ${enrich.surface || "-"}`,
      `surfaceDetail: ${enrich.surfaceDetail || "-"}`,
      `privacyStatus: ${enrich.privacyStatus || "-"}`,
      `mitigationStatus: ${enrich.mitigationStatus || "-"}`,
      `signalType: ${enrich.signalType || "-"}`,
      `patternId: ${enrich.patternId || "-"}`,
      `confidence: ${typeof enrich.confidence === "number" ? enrich.confidence.toFixed(2) : "-"}`,
    ];

    if (isApiSignalEvent(ev)) {
      const presentation = getApiEventPresentation(ev);
      return lines.concat([
        `label: ${presentation.label}`,
        `gateOutcome: ${presentation.gateOutcome}`,
        `explanation: ${presentation.explanation}`,
        `observedDetails: ${presentation.summary}`,
        "dataHandling: metadata only (no canvas output, clipboard contents, coordinates, SDP, candidates, or IP addresses)",
      ]).join("\n");
    }

    return lines.concat([
      `domain: ${d.domain || "-"}`,
      `url: ${d.url || "-"}`,
      `resourceType: ${d.resourceType || "-"}`,
      `isThirdParty: ${typeof d.isThirdParty === "boolean" ? d.isThirdParty : "-"}`,
      `ruleId: ${d.ruleId || "-"}`,
    ]).join("\n");
  }

  function renderListItems(el, items, emptyText, { hideWhenEmpty = false } = {}) {
    if (!el) return;
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    el.innerHTML = "";
    if (!list.length) {
      if (hideWhenEmpty) return false;
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = emptyText;
      el.appendChild(li);
      return false;
    }
    for (const item of list) {
      const li = document.createElement("li");
      li.textContent = item;
      el.appendChild(li);
    }
    return true;
  }

  function renderActionListItems(el, items, emptyText) {
    if (!el) return;
    const list = Array.isArray(items) ? items.filter((item) => item && item.text) : [];
    el.innerHTML = "";
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = emptyText;
      el.appendChild(li);
      return;
    }

    for (const item of list) {
      const li = document.createElement("li");
      if (item.href) {
        const link = document.createElement("a");
        link.href = item.href;
        link.className = "insight-inline-link";
        link.textContent = item.text;
        li.appendChild(link);
      } else {
        li.textContent = item.text;
      }
      el.appendChild(li);
    }
  }

  function setCaseSectionVisibility(target, visible) {
    const el = typeof target === "string" ? qs(target) : target;
    const section = el?.closest?.(".insight-case-section");
    if (section) {
      section.classList.toggle("hidden", !visible);
    }
  }

  function createEvidenceGroup(title) {
    const group = document.createElement("section");
    group.className = "insight-evidence-group";

    if (title) {
      const heading = document.createElement("div");
      heading.className = "insight-evidence-group-title";
      heading.textContent = title;
      group.appendChild(heading);
    }

    const body = document.createElement("div");
    body.className = "insight-evidence-group-body";
    group.appendChild(body);
    return { group, body };
  }

  function appendEvidenceNote(container, text) {
    const content = String(text || "").trim();
    if (!container || !content) return;
    const note = document.createElement("div");
    note.className = "insight-evidence-note";
    note.textContent = content;
    container.appendChild(note);
  }

  function appendEvidenceFact(container, label, value) {
    const factValue = String(value || "").trim();
    if (!container || !label || !factValue) return;

    const row = document.createElement("div");
    row.className = "insight-evidence-fact";

    const key = document.createElement("div");
    key.className = "insight-evidence-fact-key";
    key.textContent = label;
    row.appendChild(key);

    const content = document.createElement("div");
    content.className = "insight-evidence-fact-value";
    content.textContent = factValue;
    row.appendChild(content);

    container.appendChild(row);
  }

  function renderSupportingEvidenceBlock({
    selection,
    evidenceSummary,
    context,
    primaryEvent,
    evidence,
  } = {}) {
    const box = qs("insightHow");
    if (!box) return false;
    box.innerHTML = "";

    const summary = evidenceSummary || {};
    const label = selection?.title || "Current scope";
    const firstText = summary.firstTs ? new Date(summary.firstTs).toLocaleTimeString() : "-";
    const lastText = summary.lastTs ? new Date(summary.lastTs).toLocaleTimeString() : "-";
    const dominant = formatDominantKinds(summary.dominantKinds, getViewMode());
    const categorySummary = formatCategorySummary(summary, getViewMode());
    const whatThisAnswers = getWhatThisAnswersLine(context?.viewId);

    appendEvidenceNote(box, whatThisAnswers);

    const scopeGroup = createEvidenceGroup("Scope readout");
    appendEvidenceFact(scopeGroup.body, "Scope", label);
    appendEvidenceFact(scopeGroup.body, "Activity", `${summary.total || 0} total events`);
    appendEvidenceFact(scopeGroup.body, "Outcome", categorySummary);
    appendEvidenceFact(scopeGroup.body, "First seen", firstText);
    appendEvidenceFact(scopeGroup.body, "Last seen", lastText);
    if (selection?.bucketKey && context?.viewId !== "vendorTopDomainsEndpoints") {
      appendEvidenceFact(scopeGroup.body, "Bucket key", selection.bucketKey);
    }
    if (scopeGroup.body.childElementCount > 0) {
      box.appendChild(scopeGroup.group);
    }

    if (context?.viewId === "vendorTopDomainsEndpoints" && selection?.bucketKey) {
      const bucketGroup = createEvidenceGroup("Bucket detail");
      const bucketLabel = selection?.bucketLabel || label;
      const seen = Number(selection?.seen || 0);
      const blocked = Number(selection?.blocked || 0);
      const observed = Number(selection?.observed || 0);
      const other = Number(selection?.other || 0);
      appendEvidenceFact(bucketGroup.body, "Bucket", bucketLabel);
      appendEvidenceFact(bucketGroup.body, "Activity", `${seen} total events`);
      appendEvidenceFact(bucketGroup.body, "Outcome", `${blocked} blocked, ${observed} observed${other > 0 ? `, ${other} other` : ""}`);
      const example = getBucketExample(selection, evidence);
      if (example) {
        appendEvidenceFact(bucketGroup.body, "Example path", example);
      }
      if (bucketGroup.body.childElementCount > 0) {
        box.appendChild(bucketGroup.group);
      }
    } else if (dominant !== "-") {
      const profileGroup = createEvidenceGroup("Activity profile");
      appendEvidenceFact(profileGroup.body, "Dominant activity", dominant);
      box.appendChild(profileGroup.group);
    }

    if (primaryEvent && isApiSignalEvent(primaryEvent)) {
      const presentation = getApiEventPresentation(primaryEvent);
      const apiGroup = createEvidenceGroup("Browser API note");
      appendEvidenceFact(apiGroup.body, "Signal", presentation.label);
      appendEvidenceFact(apiGroup.body, "Meaning", presentation.explanation);
      appendEvidenceFact(apiGroup.body, "Observed detail", presentation.summary);
      appendEvidenceFact(
        apiGroup.body,
        "Classification",
        [
          presentation.canonicalId ? `pattern ${presentation.canonicalId}` : "pattern not yet classified",
          `signal type ${presentation.signalType}`,
          `confidence ${presentation.confidenceText}`,
        ].join(", "),
      );
      box.appendChild(apiGroup.group);
    }

    return box.childElementCount > 0;
  }

  function getWhatThisAnswersLine(viewId) {
    if (viewId === "vendorShareOverTime") {
      return "What this answers: How each top vendor contributes to total activity over time, including grouped long-tail vendors.";
    }
    if (viewId === "vendorTopDomainsEndpoints") {
      return "What this answers: Which domains/endpoints this selected vendor contacts most in this scope, and how much is blocked vs observed.";
    }
    return "";
  }

  function getBucketExample(selection, evidence) {
    const fromSelection = String(selection?.bucketExample || "").trim();
    if (fromSelection) return fromSelection;

    const list = Array.isArray(evidence) ? evidence : [];
    for (const ev of list) {
      const rawUrl = String(ev?.data?.url || "").trim();
      if (!rawUrl) continue;
      try {
        const parsed = new URL(rawUrl);
        return `${parsed.hostname}${parsed.pathname || "/"}`;
      } catch {
        return rawUrl;
      }
    }
    return "";
  }

  function buildCategorySummaryParts(counts) {
    const parts = [
      `${counts.blocked || 0} blocked`,
      `${counts.observed || 0} observed`,
    ];
    if (Number(counts.blockedApi || 0) > 0) parts.push(`${counts.blockedApi} blocked API`);
    if (Number(counts.observedApi || 0) > 0) parts.push(`${counts.observedApi} observed API`);
    if (Number(counts.other || 0) > 0) parts.push(`${counts.other} other`);
    return parts;
  }

  function formatInsightLeadSupport(selection, primaryEvent, context) {
    void primaryEvent;
    const label = String(selection?.title || selection?.value || "").trim();
    if (label && selection?.type && !["scope", "vendor"].includes(selection.type)) {
      return `Locked selection: ${label}.`;
    }
    const vendorName = String(context?.selectedVendor?.vendorName || "").trim();
    if (vendorName) return `Vendor focus: ${vendorName}.`;
    return "";
  }

  function setInsightSeverity(severity, confidence) {
    void confidence;
    const badge = qs("insightSeverity");
    const sheet = qs("insightSheet");
    const level = severity === "high" ? "high" : severity === "caution" ? "caution" : "info";
    if (!badge) return;
    if (sheet) sheet.dataset.severity = level;
    badge.classList.remove("severity-info", "severity-caution", "severity-high");
    if (level === "high") {
      badge.classList.add("severity-high");
      badge.textContent = "Severity: High";
      return;
    }
    if (level === "caution") {
      badge.classList.add("severity-caution");
      badge.textContent = "Severity: Caution";
      return;
    }
    badge.classList.add("severity-info");
    badge.textContent = "Severity: Info";
  }

  function showToast(message, isError = false) {
    const el = qs("actionToast");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("is-error", Boolean(isError));
    el.classList.remove("hidden");
    setTimeout(() => {
      el.classList.add("hidden");
    }, 2400);
  }

  function closeConfirmModal() {
    qs("confirmModalBackdrop")?.classList.add("hidden");
    qs("confirmModal")?.classList.add("hidden");
    pendingConfirmAction = null;
  }

  function openConfirmModal({ title, body, onConfirm }) {
    pendingConfirmAction = typeof onConfirm === "function" ? onConfirm : null;
    if (qs("confirmTitle")) qs("confirmTitle").textContent = title || "Confirm action";
    if (qs("confirmBody")) qs("confirmBody").textContent = body || "";
    qs("confirmModalBackdrop")?.classList.remove("hidden");
    qs("confirmModal")?.classList.remove("hidden");
  }

  async function confirmPendingAction() {
    const action = pendingConfirmAction;
    closeConfirmModal();
    if (!action) return;
    try {
      await action();
    } catch (err) {
      console.error(err);
      showToast("Action failed. Check backend/extension connection.", true);
    }
  }

  async function postPolicyAction(payload) {
    const res = await fetch("/api/policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Policy action failed HTTP ${res.status}`);
    return res.json();
  }

  function exportEvidence(events) {
    const list = Array.isArray(events) ? events : [];
    if (!list.length) {
      showToast("No evidence selected to export.", true);
      return;
    }

    const csvLines = ["id,ts,site,kind,mode,domain,url,resourceType,isThirdParty,ruleId"];
    for (const ev of list) {
      const d = ev?.data || {};
      csvLines.push([
        ev?.id || "",
        ev?.ts || "",
        ev?.site || "",
        ev?.kind || "",
        ev?.mode || "",
        d?.domain || "",
        d?.url || "",
        d?.resourceType || "",
        typeof d?.isThirdParty === "boolean" ? d.isThirdParty : "",
        d?.ruleId || "",
      ].map(escapeCsvCell).join(","));
    }

    const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    triggerDownload(url);
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  async function executeInsightAction(action) {
    if (!action) return;
    if (action.type === "export_evidence") {
      exportEvidence(activeEvidence);
      showToast("Exported selected evidence.");
      return;
    }

    if (action.type === "trust_site" || action.type === "block_domain") {
      await postPolicyAction(action.payload);
      showToast(`${action.label} applied.`);
    }
  }

  function renderActionButtons(box, actions, {
    maxItems = Infinity,
    includeManageLink = false,
    primaryActionIndex = -1,
  } = {}) {
    if (!box) return;
    box.innerHTML = "";

    const list = Array.isArray(actions) ? actions.slice(0, maxItems) : [];
    const hasTrustAction = list.some((action) => action?.type === "trust_site");
    list.forEach((action, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "insight-action-btn";
      if (index === primaryActionIndex) {
        btn.classList.add("insight-action-btn-primary");
      }
      btn.textContent = action.label || action.type;
      btn.addEventListener("click", async () => {
        const run = async () => {
          try {
            await executeInsightAction(action);
          } catch (err) {
            console.error(err);
            showToast("Action failed. Check backend/extension connection.", true);
          }
        };

        const needsConfirm = !!action.requiresConfirm && getViewMode() === "easy";
        if (needsConfirm) {
          openConfirmModal({
            title: action.confirmTitle || "Confirm action",
            body: action.confirmBody || "Are you sure you want to continue?",
            onConfirm: run,
          });
          return;
        }

        await run();
      });
      box.appendChild(btn);
    });

    if (includeManageLink && hasTrustAction) {
      const manageLink = document.createElement("a");
      manageLink.className = "insight-action-btn";
      manageLink.href = "/?view=trusted-sites";
      manageLink.textContent = "Manage trusted sites";
      box.appendChild(manageLink);
    }

    box.classList.toggle("hidden", box.childElementCount === 0);
  }

  function renderInsightActions(actions, footerModel = null) {
    renderActionButtons(qs("insightActions"), actions, {
      includeManageLink: true,
      primaryActionIndex: Number(footerModel?.primaryActionIndex ?? -1),
    });
    syncInsightFooterVisibility();
  }

  function getInsightLeadActions(actions) {
    const list = Array.isArray(actions) ? actions.filter(Boolean) : [];
    if (!list.length) return [];
    const preferred = list.find((action) => action?.type && action.type !== "export_evidence") || list[0];
    return preferred ? [preferred] : [];
  }

  function setInsightLeadSupport(text) {
    const el = qs("insightLeadSupport");
    if (!el) return;
    const content = String(text || "").trim();
    el.textContent = content;
    el.classList.toggle("hidden", !content);
  }

  function setInsightLeadDetail(text) {
    const el = qs("insightLeadDetail");
    if (!el) return;
    const content = String(text || "").trim();
    el.textContent = content;
    el.classList.toggle("hidden", !content);
  }

  function setInsightLeadFacts(facts) {
    const box = qs("insightLeadFacts");
    if (!box) return;
    box.innerHTML = "";

    const list = Array.isArray(facts) ? facts.filter((fact) => fact && fact.label && fact.value) : [];
    for (const fact of list) {
      const item = document.createElement("div");
      item.className = "insight-lead-fact";

      const label = document.createElement("span");
      label.className = "insight-lead-fact-label";
      label.textContent = fact.label;
      item.appendChild(label);

      const value = document.createElement("span");
      value.className = "insight-lead-fact-value";
      value.textContent = fact.value;
      item.appendChild(value);

      box.appendChild(item);
    }

    box.classList.toggle("hidden", box.childElementCount === 0);
  }

  function formatInsightLeadSeverityLabel(severity) {
    if (severity === "high") return "Severity: High";
    if (severity === "caution") return "Severity: Caution";
    return "Severity: Info";
  }

  function setInsightLeadSeverity(severity) {
    const lead = qs("insightLead");
    const badge = qs("insightLeadSeverity");
    const level = severity === "high" ? "high" : severity === "caution" ? "caution" : "info";

    if (lead) {
      lead.dataset.severity = level;
    }

    if (!badge) return;
    badge.classList.remove("severity-info", "severity-caution", "severity-high");
    if (level === "high") {
      badge.classList.add("severity-high");
    } else if (level === "caution") {
      badge.classList.add("severity-caution");
    } else {
      badge.classList.add("severity-info");
    }
    badge.textContent = formatInsightLeadSeverityLabel(level);
  }

  function setInsightConfidence(confidence) {
    const badge = qs("insightConfidence");
    if (!badge) return;
    const percent = Math.max(0, Math.min(100, Math.round((Number(confidence || 0)) * 100)));
    const band = getConfidenceBand(percent);
    badge.className = `insight-confidence-badge insight-confidence-${band}`;
    badge.textContent = `${percent}% confidence`;
  }

  function setInsightTakeaway(text) {
    const el = qs("insightTakeaway");
    if (!el) return;
    el.textContent = String(text || "").trim();
  }

  function setInsightCaseMetrics(metrics) {
    const box = qs("insightCaseMetrics");
    if (!box) return;
    box.innerHTML = "";

    const list = Array.isArray(metrics) ? metrics.filter((metric) => metric && metric.label && metric.value) : [];
    for (const metric of list) {
      const item = document.createElement("div");
      item.className = "insight-case-metric";
      item.dataset.tone = String(metric.tone || "neutral");

      const label = document.createElement("div");
      label.className = "insight-case-metric-label";
      label.textContent = metric.label;
      item.appendChild(label);

      const value = document.createElement("div");
      value.className = "insight-case-metric-value";
      value.textContent = metric.value;
      item.appendChild(value);

      if (metric.note) {
        const note = document.createElement("div");
        note.className = "insight-case-metric-note";
        note.textContent = metric.note;
        item.appendChild(note);
      }

      box.appendChild(item);
    }

    box.classList.toggle("hidden", box.childElementCount === 0);
  }

  function renderSupportingReadouts(events) {
    const box = qs("insightEvidenceReadouts");
    if (!box) return;
    box.innerHTML = "";

    const evidence = Array.isArray(events) ? events : [];
    const scopeEvents = Array.isArray(getChartEvents?.()) ? getChartEvents() : evidence;
    const viewMode = getViewMode();

    const thirdParty = evidence.filter((ev) => ev?.data?.isThirdParty === true).length;
    const firstOrUnknown = Math.max(0, evidence.length - thirdParty);
    if (evidence.length > 0) {
      const partyCard = document.createElement("section");
      partyCard.className = "insight-support-readout";
      partyCard.innerHTML = `
        <div class="insight-support-readout-title">Traffic mix</div>
        <div class="insight-support-readout-copy">${thirdParty} third-party / ${firstOrUnknown} first-party or unknown</div>
      `;
      box.appendChild(partyCard);
    }

    const selectedVendor = getSelectedVendor();
    if (viewMode === "easy" && selectedVendor?.vendorId && typeof buildVendorEndpointReadoutData === "function") {
      const readout = buildVendorEndpointReadoutData(scopeEvents, selectedVendor, { limit: 5 });
      if (Array.isArray(readout?.items) && readout.items.length) {
        const card = document.createElement("section");
        card.className = "insight-support-readout insight-support-readout-secondary";

        const title = document.createElement("div");
        title.className = "insight-support-readout-title";
        title.textContent = "Vendor connection points";
        card.appendChild(title);

        const list = document.createElement("ul");
        list.className = "insight-support-endpoint-list";

        for (const item of readout.items.slice(0, 5)) {
          const li = document.createElement("li");
          li.className = "insight-support-endpoint-item";

          const label = document.createElement("span");
          label.className = "insight-support-endpoint-label";
          label.textContent = item.displayLabel || item.fullLabel || item.bucketKey || "Endpoint";
          li.appendChild(label);

          const meta = document.createElement("span");
          meta.className = "insight-support-endpoint-meta";
          const apiSuffix = Number(item.api || 0) > 0 ? ` | ${item.api} API` : "";
          meta.textContent = `${item.blocked} blocked / ${item.observed} observed${apiSuffix}`;
          li.appendChild(meta);

          list.appendChild(li);
        }

        card.appendChild(list);
        box.appendChild(card);
      }
    }

    box.classList.toggle("hidden", box.childElementCount === 0);
  }

  function syncInsightFooterVisibility() {
    const actionSection = qs("insightActionSection");
    const footer = qs("insightActionsFooter");
    const actions = qs("insightActions");
    const hasActions = !!actions && actions.childElementCount > 0;
    footer?.classList.toggle("hidden", !hasActions);
    actionSection?.classList.toggle("hidden", !hasActions);
  }

  function buildFallbackInsight(selection, evidence) {
    const counts = summarizeVisualCategoryCounts(evidence);
    const total = counts.total;
    return {
      title: selection?.title || "Insight",
      summary: `${total} events selected (${buildCategorySummaryParts(counts).join(", ")}).`,
      severity: total >= 40 ? "caution" : "info",
      confidence: total >= 10 ? 0.72 : 0.45,
      warnings: ["Selection evidence is based on current filters and range."],
      dangers: ["Third-party requests can expose browsing behavior to external services."],
      precautions: ["Review vendor necessity before allowing persistent activity."],
      actions: [
        {
          type: "trust_site",
          label: "Trust this site",
          payload: { op: "trust_site", payload: { site: getSiteName() } },
          requiresConfirm: true,
          confirmTitle: "Trust this site?",
          confirmBody: "Trusting can reduce protection for this site.",
        },
        {
          type: "export_evidence",
          label: "Export selected evidence",
        },
      ],
      evidenceSummary: {
        total,
        blocked: counts.blocked,
        observed: counts.observed,
        blockedApi: counts.blockedApi,
        observedApi: counts.observedApi,
        api: counts.api,
        other: counts.other,
        firstTs: evidence[0]?.ts || null,
        lastTs: evidence[evidence.length - 1]?.ts || null,
        dominantKinds: [],
      },
    };
  }

  function renderBrowserApiNarrative(events) {
    const container = qs("insightApiNarrative");
    const concern = qs("insightApiNarrativeConcern");
    const headline = qs("insightApiNarrativeHeadline");
    const detail = qs("insightApiNarrativeDetail");
    const whyList = qs("insightApiNarrativeWhy");
    const actionsList = qs("insightApiNarrativeActions");
    if (!container || !concern || !headline || !detail || !whyList || !actionsList) return;

    const subject = getSelectedVendor() ? "this vendor-focused scope" : "this site";
    const narrative = buildSiteBrowserApiNarrative(events, { subject });
    if (!narrative) {
      container.classList.add("hidden");
      concern.className = "insight-api-narrative-concern";
      concern.textContent = "";
      headline.textContent = "";
      detail.textContent = "";
      renderListItems(whyList, [], "No Browser API-specific privacy meaning in the current scope.");
      renderActionListItems(actionsList, [], "No Browser API-specific actions for the current scope.");
      return;
    }

    container.classList.remove("hidden");
    concern.className = `insight-api-narrative-concern insight-api-narrative-concern-${narrative.concern.level}`;
    concern.textContent = narrative.concern.label;
    headline.textContent = narrative.headline;
    detail.textContent = narrative.detail;
    renderListItems(whyList, narrative.whyItMatters, "No Browser API-specific privacy meaning in the current scope.");
    renderActionListItems(actionsList, narrative.actions, "No Browser API-specific actions for the current scope.");
  }

  function resetInsightLead() {
    setInsightLeadSeverity("info");
    if (qs("insightLeadSummary")) {
      qs("insightLeadSummary").textContent = "Waiting for captured activity in the current scope.";
    }
    setInsightLeadDetail("");
    setInsightLeadSupport("");
    setInsightLeadFacts([]);
    renderActionButtons(qs("insightLeadActions"), [], { maxItems: 1 });
  }

  function renderInsightLead(selection, evidence) {
    const model = buildInsightView(selection, evidence);
    activeEvidence = model.evs;
    const presentation = buildInsightLeadPresentation({
      insight: model.insight,
      evidence: model.evs,
    });

    if (qs("insightLeadSummary")) {
      qs("insightLeadSummary").textContent = presentation.headline;
    }
    setInsightLeadDetail(presentation.detail);
    setInsightLeadSupport(formatInsightLeadSupport(selection, model.primaryEvent, model.context));
    setInsightLeadFacts(presentation.facts);
    setInsightLeadSeverity(model.insight?.severity);
    renderActionButtons(qs("insightLeadActions"), [], { maxItems: 1 });
    return model;
  }

  function openInsightSheet(selection, evidence, {
    forceScroll = false,
    allowAutoScroll = true,
    scrollSource = "selection",
  } = {}) {
    const model = renderInsightLead(selection, evidence);
    const { selection: activeSelection, evs, primaryEvent, context, insight } = model;
    const caseSheet = buildInsightCaseSheetPresentation({
      insight,
      evidence: evs,
    });

    if (qs("insightTitle")) qs("insightTitle").textContent = "Detailed evidence";
    if (qs("insightMeta")) {
      const label = activeSelection?.title || "Current scope";
      qs("insightMeta").textContent = `${label} • ${evs.length} events`;
    }
    if (qs("insightSelectedLead")) qs("insightSelectedLead").textContent = formatSelectedLead(activeSelection, primaryEvent);
    setInsightTakeaway(caseSheet.takeaway);
    if (qs("insightSummary")) {
      const summaryText = String(caseSheet.summaryDetail || "").trim()
        || `This finding is based on ${Number(insight?.evidenceSummary?.total || evs.length || 0)} captured events in the current scope.`;
      qs("insightSummary").textContent = summaryText;
    }

    setInsightSeverity(insight.severity, insight.confidence);
    setInsightConfidence(insight.confidence);
    setInsightCaseMetrics(caseSheet.metrics);

    const summary = insight.evidenceSummary || {};
    const hasSupportingEvidence = renderSupportingEvidenceBlock({
      selection: activeSelection,
      evidenceSummary: summary,
      context,
      primaryEvent,
      evidence: evs,
    });

    const whyItems = [
      ...(Array.isArray(insight.warnings) ? insight.warnings : []),
      ...(Array.isArray(insight.dangers) ? insight.dangers : []),
    ];
    const baseLimits = Array.isArray(insight.precautions) ? insight.precautions : [];
    const limits = [
      ...baseLimits,
      "Evidence is constrained by current range/filters and captured events only.",
    ];
    if (context.viewId === "baselineDetectedBlockedTrend") {
      limits.push("'No signal detected' indicates no classified signal in captured events, not a guarantee of safety.");
    }
    if (evs.some((eventItem) => isApiSignalEvent(eventItem))) {
      limits.push("Browser API evidence here is metadata only. VPT stores classification and call metadata, not canvas output, clipboard contents, coordinates, SDP, candidates, or IP addresses.");
    }
    if (evs.length < 8) {
      limits.push("Low confidence due to small sample size; gather more events before acting.");
    }

    const hasWhyItems = renderListItems(qs("insightWhy"), whyItems, "", { hideWhenEmpty: true });
    qs("insightWhy")?.classList.toggle("hidden", !hasWhyItems);
    const hasLimits = renderListItems(qs("insightLimits"), limits, "", { hideWhenEmpty: true });
    renderSupportingReadouts(evs);
    const hasReadouts = (qs("insightEvidenceReadouts")?.childElementCount || 0) > 0;
    setCaseSectionVisibility(qs("insightSummary"), !!String(qs("insightSummary")?.textContent || "").trim() || hasWhyItems);
    setCaseSectionVisibility(qs("insightHow"), hasSupportingEvidence || hasReadouts);
    setCaseSectionVisibility(qs("insightLimits"), hasLimits);

    if (getViewMode() === "power" && evs.length) {
      openDrawer(activeSelection?.title, evs);
    } else {
      closeDrawer();
    }

    renderInsightActions(insight.actions || [], caseSheet.footer);
    if (forceScroll || allowAutoScroll) {
      ensureInsightVisible({ force: !!forceScroll, source: scrollSource });
    }
  }

  function resetInsightSection() {
    closeDrawer();
    if (qs("insightTitle")) qs("insightTitle").textContent = "Detailed evidence";
    if (qs("insightMeta")) qs("insightMeta").textContent = "Select a chart point or use Explain / Info for a deeper breakdown.";
    setInsightSeverity("info", 0.45);
    setInsightConfidence(0.45);
    if (qs("insightSelectedLead")) qs("insightSelectedLead").textContent = "You selected: no datapoint yet.";
    setInsightTakeaway("Choose a datapoint or use Explain / Info to expand the current deterministic scope summary.");
    if (qs("insightSummary")) qs("insightSummary").textContent = "Select a chart point to inspect why this scope stands out.";
    if (qs("insightHow")) qs("insightHow").textContent = "Select a chart point to inspect captured evidence for this scope.";
    setInsightCaseMetrics([]);
    renderListItems(qs("insightWhy"), [], "", { hideWhenEmpty: true });
    qs("insightWhy")?.classList.add("hidden");
    renderListItems(qs("insightLimits"), ["Insights reflect captured events in the active range and filters."], "", { hideWhenEmpty: true });
    renderSupportingReadouts([]);
    setCaseSectionVisibility(qs("insightSummary"), true);
    setCaseSectionVisibility(qs("insightHow"), true);
    setCaseSectionVisibility(qs("insightLimits"), true);
    renderInsightActions([]);
    syncInsightFooterVisibility();
  }

  function closeInsightSheet() {
    resetInsightSection();
  }

  function clearActiveEvidence() {
    activeEvidence = [];
  }

  function openDrawer(title, evidenceEvents) {
    if (getViewMode() !== "power") {
      closeDrawer();
      return;
    }
    const panel = qs("insightTechnicalPanel");
    if (!panel) return;

    panel.classList.remove("hidden");
    syncInsightFooterVisibility();

    qs("drawerTitle").textContent = title || "Selection";
    qs("drawerSummary").innerHTML = "";

    const box = qs("drawerEvents");
    box.innerHTML = "";

    const list = (evidenceEvents || []).slice(-20).reverse();
    if (!list.length) {
      box.innerHTML = '<div class="muted">No matching events.</div>';
      qs("drawerSummary").innerHTML = '<div class="muted">No advanced details available.</div>';
      activeDrawerEvent = null;
    } else {
      let firstEvent = null;
      for (const ev of list) {
        const btn = document.createElement("button");
        btn.className = "event-row";
        btn.type = "button";
        btn.innerHTML = `<div style="font-size:12px;opacity:.8">${getEventListMetaText(ev)}</div>
                       <div style="font-size:13px">${getEventListKindText(ev)}</div>
                       <div style="font-size:12px;opacity:.78">${getEventListContextText(ev)}</div>`;
        if (!firstEvent) firstEvent = { ev, btn };

        btn.addEventListener("click", () => {
          activeDrawerEvent = ev;
          const adv = explainEventAdvanced(activeDrawerEvent).replaceAll("\n", "<br/>");
          for (const node of box.querySelectorAll(".event-row")) {
            node.classList.remove("active");
          }
          btn.classList.add("active");
          qs("drawerSummary").innerHTML = `<pre style="white-space:pre-wrap">${adv}</pre>`;
        });

        box.appendChild(btn);
      }
      if (firstEvent) firstEvent.btn.click();
    }
  }

  return {
    closeDrawer,
    resetInsightLead,
    renderInsightLead,
    resetInsightSection,
    closeInsightSheet,
    renderBrowserApiNarrative,
    showToast,
    closeConfirmModal,
    confirmPendingAction,
    openInsightSheet,
    openDrawer,
    clearActiveEvidence,
  };
}
