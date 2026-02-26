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
    getViews,
    getVizIndex,
  } = deps;

  let activeEvidence = [];
  let pendingConfirmAction = null;
  let activeDrawerEvent = null;

  function closeDrawer() {
    const panel = qs("insightTechnicalPanel");
    panel?.classList.add("hidden");
    if (panel) panel.open = false;
    if (qs("drawerSummary")) qs("drawerSummary").innerHTML = "";
    if (qs("drawerEvents")) qs("drawerEvents").innerHTML = "";
    activeDrawerEvent = null;
  }

  function explainEventAdvanced(ev) {
    if (!ev) return "";

    const d = ev.data || {};
    return [
      `id: ${ev.id || "-"}`,
      `ts: ${ev.ts ? new Date(ev.ts).toLocaleString() : "-"}`,
      `site: ${ev.site || "-"}`,
      `kind: ${ev.kind || "-"}`,
      `mode: ${ev.mode || "-"}`,
      `domain: ${d.domain || "-"}`,
      `url: ${d.url || "-"}`,
      `resourceType: ${d.resourceType || "-"}`,
      `isThirdParty: ${typeof d.isThirdParty === "boolean" ? d.isThirdParty : "-"}`,
      `ruleId: ${d.ruleId || "-"}`,
    ].join("\n");
  }

  function renderListItems(el, items, emptyText) {
    if (!el) return;
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
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
      li.textContent = item;
      el.appendChild(li);
    }
  }

  function getWhatThisAnswersLine(viewId) {
    if (viewId === "vendorBlockRateComparison") {
      return "What this answers: Which vendors have the highest blocked-share in this scope, relative to their total observed activity.";
    }
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

  function setInsightSeverity(severity, confidence) {
    const badge = qs("insightSeverity");
    if (!badge) return;
    badge.classList.remove("severity-info", "severity-caution", "severity-high");
    if (severity === "high") {
      badge.classList.add("severity-high");
      badge.textContent = `High (${Math.round((confidence || 0) * 100)}% confidence)`;
      return;
    }
    if (severity === "caution") {
      badge.classList.add("severity-caution");
      badge.textContent = `Caution (${Math.round((confidence || 0) * 100)}% confidence)`;
      return;
    }
    badge.classList.add("severity-info");
    badge.textContent = `Info (${Math.round((confidence || 0) * 100)}% confidence)`;
  }

  function showToast(message, isError = false) {
    const el = qs("actionToast");
    if (!el) return;
    el.textContent = message || "";
    el.style.borderColor = isError ? "rgba(251,113,133,0.55)" : "rgba(148,163,184,0.3)";
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

  function renderInsightActions(actions) {
    const box = qs("insightActions");
    if (!box) return;
    box.innerHTML = "";

    const list = Array.isArray(actions) ? actions : [];
    for (const action of list) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "insight-action-btn";
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
    }
  }

  function buildFallbackInsight(selection, evidence) {
    const total = evidence.length;
    const blocked = evidence.filter((e) => e?.kind === "network.blocked").length;
    const observed = evidence.filter((e) => e?.kind === "network.observed").length;
    return {
      title: selection?.title || "Insight",
      summary: `${total} events selected (${blocked} blocked, ${observed} observed).`,
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
        blocked,
        observed,
        other: Math.max(0, total - blocked - observed),
        firstTs: evidence[0]?.ts || null,
        lastTs: evidence[evidence.length - 1]?.ts || null,
        dominantKinds: [],
      },
    };
  }

  function openInsightSheet(selection, evidence, {
    forceScroll = false,
    allowAutoScroll = true,
    scrollSource = "selection",
  } = {}) {
    const insightApi = getInsightRules();
    const evs = Array.isArray(evidence) ? evidence.filter(Boolean) : [];
    activeEvidence = evs;
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

    if (qs("insightTitle")) qs("insightTitle").textContent = insight.title || "Info";
    if (qs("insightMeta")) qs("insightMeta").textContent = `${evs.length} events selected`;
    if (qs("insightSelectedLead")) qs("insightSelectedLead").textContent = formatSelectedLead(selection, primaryEvent);
    if (qs("insightSummary")) qs("insightSummary").textContent = insight.summary || "No summary generated.";

    setInsightSeverity(insight.severity, insight.confidence);

    const summary = insight.evidenceSummary || {};
    const firstText = summary.firstTs ? new Date(summary.firstTs).toLocaleTimeString() : "-";
    const lastText = summary.lastTs ? new Date(summary.lastTs).toLocaleTimeString() : "-";
    const dominant = Array.isArray(summary.dominantKinds) && summary.dominantKinds.length
      ? summary.dominantKinds.map((d) => `${d.kind}:${d.count}`).join(", ")
      : "-";

    if (qs("insightHow")) {
      const label = selection?.title || "current scope";
      const evidenceLine = `From ${label}: total ${summary.total || 0}, blocked ${summary.blocked || 0}, observed ${summary.observed || 0}, first ${firstText}, last ${lastText}, dominant ${dominant}.`;
      const whatThisAnswers = getWhatThisAnswersLine(context.viewId);
      if (context.viewId === "vendorTopDomainsEndpoints" && selection?.bucketKey) {
        const bucketLabel = selection?.bucketLabel || label;
        const seen = Number(selection?.seen || 0);
        const blocked = Number(selection?.blocked || 0);
        const observed = Number(selection?.observed || 0);
        const other = Number(selection?.other || 0);
        const bucketLine = `Selected bucket: ${bucketLabel} (${seen} total; ${blocked} blocked; ${observed} observed; ${other} other).`;
        const example = getBucketExample(selection, evs);
        const exampleLine = example ? ` Example URL/path: ${example}.` : "";
        qs("insightHow").textContent = `${whatThisAnswers ? `${whatThisAnswers} ` : ""}${bucketLine}${exampleLine}`;
      } else {
        const bucketKeyLine = selection?.bucketKey
          ? ` Bucket key: ${selection.bucketKey}.`
          : "";
        qs("insightHow").textContent = `${whatThisAnswers ? `${whatThisAnswers} ` : ""}${evidenceLine}${bucketKeyLine}`;
      }
    }

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
    if (evs.length < 8) {
      limits.push("Low confidence due to small sample size; gather more events before acting.");
    }

    renderListItems(qs("insightWhy"), whyItems, "No immediate risk narrative for this scope.");
    renderListItems(qs("insightLimits"), limits, "No additional caveats.");

    if (getViewMode() === "power" && evs.length) {
      openDrawer(selection?.title, evs);
    } else {
      closeDrawer();
    }

    renderInsightActions(insight.actions || []);
    if (forceScroll || allowAutoScroll) {
      ensureInsightVisible({ force: !!forceScroll, source: scrollSource });
    }
  }

  function resetInsightSection() {
    closeDrawer();
    if (qs("insightTitle")) qs("insightTitle").textContent = "Info";
    if (qs("insightMeta")) qs("insightMeta").textContent = "Select a chart point to explain current evidence.";
    if (qs("insightSelectedLead")) qs("insightSelectedLead").textContent = "You selected: no datapoint yet.";
    if (qs("insightSummary")) qs("insightSummary").textContent = "No selection yet. Choose a datapoint or press Explain / Info to summarize the current scope.";
    if (qs("insightHow")) qs("insightHow").textContent = "This section describes deterministic evidence from current range, filters, and selected scope.";
    renderListItems(qs("insightWhy"), [], "No immediate risk narrative until evidence is selected.");
    renderListItems(qs("insightLimits"), [], "Derived from captured events only; not a complete audit of all page behavior.");
    renderInsightActions([]);
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
        btn.innerHTML = `<div style="font-size:12px;opacity:.8">${friendlyTime(ev.ts)} | ${ev.kind || "-"} | ${ev.mode || "-"}</div>
                       <div style="font-size:13px">${ev.data?.domain || "-"}</div>`;
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
    resetInsightSection,
    closeInsightSheet,
    showToast,
    closeConfirmModal,
    confirmPendingAction,
    openInsightSheet,
    openDrawer,
    clearActiveEvidence,
  };
}
