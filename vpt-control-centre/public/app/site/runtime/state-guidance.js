export function buildStateGuidanceModel({
  eventCount = 0,
  hasVendorFocus = false,
  vendorName = "",
  activeFilterCount = 0,
  lensPivotActive = false,
  emptyMessage = "",
  viewId = "",
  lowInformationThreshold = 8,
} = {}) {
  const total = Number(eventCount || 0);
  const conciseMessage = String(emptyMessage || "").trim();
  let message = "";

  const normalizeBuilderMessage = (value) => {
    const text = String(value || "").trim();
    if (!text) return "";
    const lower = text.toLowerCase();
    if (lower.includes("comparison") && lower.includes("low")) {
      return "Limited comparison signal in the current scope.";
    }
    if (lower.includes("endpoint")) {
      return `Limited endpoint detail${vendorName ? ` for ${vendorName}` : ""} in the current scope.`;
    }
    if (lower.includes("no events") || lower.includes("no activity")) {
      return hasVendorFocus
        ? `No activity for ${vendorName || "this vendor"} in the current scope.`
        : "No activity in the current scope.";
    }
    if (lower.includes("focused timeline")) {
      return `Focused timeline shown because comparison is thin${vendorName ? ` for ${vendorName}` : ""}.`;
    }
    return text;
  };

  if (!total) {
    message = normalizeBuilderMessage(conciseMessage)
      || (hasVendorFocus
        ? `No activity for ${vendorName || "this vendor"} in the current scope.`
        : "No activity in the current scope.");
  } else if (lensPivotActive) {
    message = `Focused timeline shown because comparison is thin${vendorName ? ` for ${vendorName}` : ""}.`;
  } else if (viewId === "vendorTopDomainsEndpoints" && conciseMessage) {
    message = normalizeBuilderMessage(conciseMessage);
  } else if (total < Number(lowInformationThreshold || 8)) {
    message = `Limited signal in the current scope: ${total} events.`;
  } else if (conciseMessage) {
    message = normalizeBuilderMessage(conciseMessage);
  }

  if (!message) {
    return { message: "", actions: [] };
  }

  const actions = [];
  actions.push({ id: "broaden_range", label: "Broaden range" });
  if (hasVendorFocus || lensPivotActive) {
    actions.push({ id: "clear_vendor", label: "Clear vendor" });
  } else if (activeFilterCount > 0) {
    actions.push({ id: "reset_filters", label: "Reset filters" });
  } else {
    actions.push({ id: "switch_chart", label: "Switch chart" });
  }

  return {
    message,
    actions: actions.slice(0, 2),
  };
}
