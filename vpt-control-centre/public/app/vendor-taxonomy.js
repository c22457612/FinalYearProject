/*
 * Vendor taxonomy and domain classification helpers for site insights.
 * This file is intentionally framework-free and exposes a small API on window.VPT.
 */
(function initVendorTaxonomy(global) {
  const root = global.VPT = global.VPT || {};

  /** @typedef {{vendorId:string,vendorName:string,category:string,domains:string[],riskHints:string[]}} VendorProfile */

  /** @type {VendorProfile[]} */
  const VENDOR_PROFILES = [
    {
      vendorId: "google",
      vendorName: "Google",
      category: "adtech-analytics",
      domains: [
        "google-analytics.com",
        "googletagmanager.com",
        "doubleclick.net",
        "gstatic.com",
        "googleadservices.com",
        "googlesyndication.com",
        "google.com",
      ],
      riskHints: ["cross-site profiling", "behavioral advertising", "high coverage across sites"],
    },
    {
      vendorId: "meta",
      vendorName: "Meta/Facebook",
      category: "social-adtech",
      domains: ["facebook.com", "facebook.net", "fbsbx.com"],
      riskHints: ["cross-site tracking", "audience enrichment"],
    },
    {
      vendorId: "microsoft",
      vendorName: "Microsoft/Bing",
      category: "adtech-analytics",
      domains: ["bing.com", "bat.bing.com", "clarity.ms", "microsoft.com"],
      riskHints: ["telemetry collection", "ad measurement"],
    },
    {
      vendorId: "amazon",
      vendorName: "Amazon/CloudFront",
      category: "cdn-commerce",
      domains: ["amazon-adsystem.com", "cloudfront.net", "amazonaws.com", "amzn.to"],
      riskHints: ["cdn + advertising infrastructure", "request correlation risk"],
    },
    {
      vendorId: "outbrain",
      vendorName: "Outbrain",
      category: "adtech",
      domains: ["outbrain.com"],
      riskHints: ["content recommendation tracking"],
    },
    {
      vendorId: "taboola",
      vendorName: "Taboola",
      category: "adtech",
      domains: ["taboola.com"],
      riskHints: ["recommendation and ad profiling"],
    },
    {
      vendorId: "segment",
      vendorName: "Segment",
      category: "analytics",
      domains: ["segment.com", "segment.io"],
      riskHints: ["event stream aggregation"],
    },
    {
      vendorId: "mixpanel",
      vendorName: "Mixpanel",
      category: "analytics",
      domains: ["mixpanel.com"],
      riskHints: ["product analytics fingerprinting risk"],
    },
  ];

  function normalizeHost(raw) {
    const input = String(raw || "").trim().toLowerCase();
    if (!input) return "";

    let host = input;
    try {
      if (host.includes("://")) {
        host = new URL(host).hostname || host;
      } else if (host.includes("/")) {
        host = host.split("/")[0];
      }
    } catch {
      // keep best-effort host
    }

    host = host.replace(/^www\./, "");
    return host;
  }

  function toBaseDomain(raw) {
    const host = normalizeHost(raw);
    if (!host) return "";
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 2) return host;
    return parts.slice(-2).join(".");
  }

  function findProfileForHost(host) {
    const normalized = normalizeHost(host);
    if (!normalized) return null;

    for (const profile of VENDOR_PROFILES) {
      for (const d of profile.domains) {
        if (normalized === d || normalized.endsWith(`.${d}`)) {
          return { profile, matchedDomain: d };
        }
      }
    }

    return null;
  }

  function classifyDomain(rawDomain) {
    const normalized = normalizeHost(rawDomain);
    if (!normalized) {
      return {
        vendorId: "unknown",
        vendorName: "Unknown vendor",
        category: "unknown",
        domains: [],
        riskHints: ["insufficient domain data"],
        matchedDomain: "",
        domain: "",
        known: false,
      };
    }

    const hit = findProfileForHost(normalized);
    if (hit) {
      return {
        ...hit.profile,
        matchedDomain: hit.matchedDomain,
        domain: normalized,
        known: true,
      };
    }

    const fallback = toBaseDomain(normalized) || normalized;
    return {
      vendorId: fallback,
      vendorName: fallback,
      category: "unmapped",
      domains: [fallback],
      riskHints: ["vendor is not in the curated taxonomy"],
      matchedDomain: fallback,
      domain: normalized,
      known: false,
    };
  }

  function classifyEvent(ev) {
    const domain = ev?.data?.domain || ev?.site || "";
    return classifyDomain(domain);
  }

  function rollupVendors(events) {
    const map = new Map();
    const list = Array.isArray(events) ? events : [];

    for (const ev of list) {
      const vendor = classifyEvent(ev);
      const id = vendor.vendorId;
      if (!map.has(id)) {
        map.set(id, {
          vendorId: id,
          vendorName: vendor.vendorName,
          category: vendor.category,
          riskHints: vendor.riskHints || [],
          domains: new Set(),
          seen: 0,
          blocked: 0,
          observed: 0,
          other: 0,
          evs: [],
        });
      }

      const row = map.get(id);
      row.seen += 1;
      if (ev?.kind === "network.blocked") row.blocked += 1;
      else if (ev?.kind === "network.observed") row.observed += 1;
      else row.other += 1;
      if (vendor.domain) row.domains.add(vendor.domain);
      row.evs.push(ev);
    }

    return Array.from(map.values()).map((row) => ({
      ...row,
      domains: Array.from(row.domains).sort(),
    }));
  }

  root.vendorTaxonomy = {
    VENDOR_PROFILES,
    normalizeHost,
    toBaseDomain,
    classifyDomain,
    classifyEvent,
    rollupVendors,
  };
})(window);
