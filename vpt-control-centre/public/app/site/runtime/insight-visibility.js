export function createInsightVisibility(deps) {
  const {
    qs,
    onSelectVendorProfileModule,
  } = deps;

  let insightScrollRaf = null;
  let vendorSelectionCueTimer = null;

  function isOffScreen(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
    const topSafe = 72;
    const bottomSafe = viewportH - 48;
    return rect.top < topSafe || rect.bottom > bottomSafe;
  }

  function getScrollTop() {
    return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }

  function smoothScrollViewportTo(targetY, { durationMs = 520 } = {}) {
    const target = Math.max(0, Number(targetY || 0));
    const start = getScrollTop();
    const delta = target - start;
    if (Math.abs(delta) < 2) return;

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      window.scrollTo({ top: target, left: 0, behavior: "auto" });
      return;
    }

    if (insightScrollRaf) {
      cancelAnimationFrame(insightScrollRaf);
      insightScrollRaf = null;
    }

    const startTime = performance.now();
    const easeInOutCubic = (t) => (t < 0.5
      ? 4 * t * t * t
      : 1 - (Math.pow(-2 * t + 2, 3) / 2));

    const tick = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / Math.max(120, durationMs));
      const eased = easeInOutCubic(progress);
      window.scrollTo(0, start + delta * eased);
      if (progress < 1) {
        insightScrollRaf = requestAnimationFrame(tick);
      } else {
        insightScrollRaf = null;
      }
    };

    insightScrollRaf = requestAnimationFrame(tick);
  }

  function pulseElement(el, className = "attention-pulse") {
    if (!el) return;
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
  }

  function ensureInsightVisible({ force = false, source = "selection" } = {}) {
    const section = qs("insightSheet");
    if (!section) return;
    if (!(force || isOffScreen(section))) return;

    const rect = section.getBoundingClientRect();
    const targetY = getScrollTop() + rect.top - 72;
    const durationMs = source === "vendor" ? 640 : 460;
    smoothScrollViewportTo(targetY, { durationMs });
    pulseElement(section);
  }

  function hideVendorSelectionCue() {
    if (vendorSelectionCueTimer) {
      clearTimeout(vendorSelectionCueTimer);
      vendorSelectionCueTimer = null;
    }
    qs("vendorSelectionCue")?.classList.add("hidden");
  }

  function showVendorSelectionCue(vendorName, count = 0) {
    const box = qs("vendorSelectionCue");
    const text = qs("vendorSelectionCueText");
    if (!box || !text) return;

    const countText = Number.isFinite(Number(count)) && Number(count) > 0
      ? ` (${Number(count)} events in current scope)`
      : "";
    text.textContent = `Selected vendor: ${vendorName}${countText}. Info and Vendor profile were updated.`;
    box.classList.remove("hidden");
    pulseElement(box);

    if (vendorSelectionCueTimer) clearTimeout(vendorSelectionCueTimer);
    vendorSelectionCueTimer = setTimeout(() => {
      box.classList.add("hidden");
    }, 4200);
  }

  function focusVendorDetailsUx(vendorName, count = 0) {
    if (!vendorName) return;
    showVendorSelectionCue(vendorName, count);
    if (typeof onSelectVendorProfileModule === "function") onSelectVendorProfileModule();
    pulseElement(qs("sidebarModuleVendorProfile"));
  }

  return {
    isOffScreen,
    getScrollTop,
    smoothScrollViewportTo,
    pulseElement,
    ensureInsightVisible,
    hideVendorSelectionCue,
    showVendorSelectionCue,
    focusVendorDetailsUx,
  };
}
