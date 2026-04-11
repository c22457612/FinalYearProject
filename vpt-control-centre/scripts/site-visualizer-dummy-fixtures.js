const DUMMY_SOURCE = "dummy-seed-site-visualizer";
const SEEDED_EVENT_ID_PREFIX = "dummy-seed-site-viz-";
const SEEDED_SITES = Object.freeze([
  "streaming-hub.demo.local",
  "daily-news.demo.local",
  "checkout-plus.demo.local",
  "community-forum.demo.local",
]);

const SITE_KEYS = Object.freeze({
  "streaming-hub.demo.local": "streaming",
  "daily-news.demo.local": "news",
  "checkout-plus.demo.local": "checkout",
  "community-forum.demo.local": "forum",
});

function minutesAgoToTs(now, minutesAgo) {
  return Number(now) - (Number(minutesAgo) * 60 * 1000);
}

function makeCookie(name, domain, extra = {}) {
  return {
    name,
    domain,
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "lax",
    session: false,
    hostOnly: !String(domain || "").startsWith("."),
    isThirdParty: false,
    ...extra,
  };
}

function buildScenarioEvents(now = Date.now()) {
  let sequence = 0;
  const events = [];

  function nextId(site, label) {
    sequence += 1;
    const safeLabel = String(label || "event").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `${SEEDED_EVENT_ID_PREFIX}${SITE_KEYS[site]}-${String(sequence).padStart(3, "0")}-${safeLabel}`;
  }

  function pushEvent(site, minutesAgo, kind, mode, data, label, extra = {}) {
    events.push({
      id: nextId(site, label),
      ts: minutesAgoToTs(now, minutesAgo),
      source: DUMMY_SOURCE,
      site,
      kind,
      mode,
      topLevelUrl: extra.topLevelUrl || `https://${site}/`,
      ...extra,
      data,
    });
  }

  function pushNetwork(site, cfg) {
    const domain = cfg.domain || site;
    const query = cfg.query ? `?${cfg.query}` : "";
    pushEvent(
      site,
      cfg.minutesAgo,
      cfg.kind || "network.observed",
      cfg.mode || "moderate",
      {
        url: cfg.url || `https://${domain}${cfg.path || "/"}${query}`,
        domain,
        isThirdParty: cfg.isThirdParty !== false,
        resourceType: cfg.resourceType || "script",
        ...(cfg.ruleId ? { ruleId: cfg.ruleId } : {}),
      },
      cfg.label
    );
  }

  function pushApi(site, cfg) {
    const domain = cfg.domain || "";
    const query = cfg.query ? `?${cfg.query}` : "";
    pushEvent(
      site,
      cfg.minutesAgo,
      cfg.kind,
      cfg.mode || "moderate",
      {
        surface: "api",
        surfaceDetail: cfg.surfaceDetail,
        ...(domain ? { domain } : {}),
        ...(cfg.url || domain ? { url: cfg.url || `https://${domain}${cfg.path || "/"}${query}` } : {}),
        ...(typeof cfg.isThirdParty === "boolean" ? { isThirdParty: cfg.isThirdParty } : {}),
        ...cfg.data,
      },
      cfg.label
    );
  }

  function pushCookies(site, cfg) {
    const cookies = Array.isArray(cfg.cookies) ? cfg.cookies : [];
    pushEvent(
      site,
      cfg.minutesAgo,
      "cookies.snapshot",
      cfg.mode || "moderate",
      {
        url: cfg.url || `https://${site}${cfg.path || "/"}`,
        siteBase: site,
        count: typeof cfg.count === "number" ? cfg.count : cookies.length,
        thirdPartyCount: typeof cfg.thirdPartyCount === "number"
          ? cfg.thirdPartyCount
          : cookies.filter((cookie) => cookie?.isThirdParty === true).length,
        cookies,
      },
      cfg.label
    );
  }

  const streaming = "streaming-hub.demo.local";
  [
    { minutesAgo: 30, kind: "network.observed", domain: "www.googletagmanager.com", path: "/gtm.js", query: "id=GTM-SH001", resourceType: "script", label: "gtm-bootstrap" },
    { minutesAgo: 28, kind: "network.observed", domain: "www.google-analytics.com", path: "/g/collect", query: "cid=sh-001&sid=session-a&dl=home", resourceType: "xmlhttprequest", label: "ga-session-a" },
    { minutesAgo: 26, kind: "network.observed", domain: "api.segment.io", path: "/v1/t", query: "ajs_user_id=viewer-01&writeKey=seg-1", resourceType: "fetch", label: "segment-home" },
    { minutesAgo: 24, kind: "network.blocked", domain: "securepubads.g.doubleclick.net", path: "/gampad/ads", query: "iu=/123/stream&sz=640x360", resourceType: "sub_frame", ruleId: "rule.block.doubleclick", label: "doubleclick-ad-slot" },
    { minutesAgo: 22, kind: "network.observed", domain: "static.cloudflarestream.com", path: "/player.js", query: "session=abc", resourceType: "script", label: "cloudfront-player" },
    { minutesAgo: 20, kind: "network.observed", domain: "connect.facebook.net", path: "/signals/config.js", query: "id=streaming-pixel", resourceType: "script", label: "meta-pixel-loader" },
    { minutesAgo: 18, kind: "network.blocked", domain: "googleadservices.com", path: "/pagead/conversion.js", query: "label=streaming-upsell", resourceType: "script", ruleId: "rule.block.googleadservices", label: "googleadservices-blocked" },
    { minutesAgo: 16, kind: "network.observed", domain: streaming, path: "/api/recommendations", query: "sessionId=watch-201&device=tv", resourceType: "fetch", isThirdParty: false, label: "recommendations-first-party" },
    { minutesAgo: 15, kind: "network.observed", domain: "api.mixpanel.com", path: "/track/", query: "distinct_id=viewer-01&event=playback_started", resourceType: "xmlhttprequest", label: "mixpanel-playback" },
    { minutesAgo: 12, kind: "network.blocked", domain: "ads.yahoo.com", path: "/pixel", query: "campaign=holiday-stream", resourceType: "image", ruleId: "rule.block.yahoo-ads", label: "yahoo-pixel" },
    { minutesAgo: 180, kind: "network.observed", domain: streaming, path: "/api/title/season-2", query: "locale=en-IE", resourceType: "fetch", isThirdParty: false, label: "catalog-first-party" },
    { minutesAgo: 3600, kind: "network.observed", domain: "www.googletagmanager.com", path: "/gtm.js", query: "id=GTM-SH001&view=library", resourceType: "script", label: "older-gtm-refresh" },
  ].forEach((cfg) => pushNetwork(streaming, { mode: cfg.isThirdParty === false ? "moderate" : "strict", ...cfg }));
  [
    {
      minutesAgo: 25,
      label: "cookies-home",
      cookies: [
        makeCookie("__Host-stream_session", streaming, { httpOnly: true, session: true }),
        makeCookie("theme_pref", streaming, { secure: false }),
        makeCookie("_ga", streaming),
        makeCookie("_fbp", ".facebook.com", { sameSite: "no_restriction", isThirdParty: true }),
        makeCookie("ajs_anonymous_id", ".segment.io", { sameSite: "no_restriction", isThirdParty: true }),
      ],
    },
    {
      minutesAgo: 240,
      label: "cookies-player",
      cookies: [
        makeCookie("playback_quality", streaming),
        makeCookie("remember_volume", streaming, { secure: false }),
        makeCookie("mp_123_mixpanel", ".mixpanel.com", { sameSite: "no_restriction", isThirdParty: true }),
        makeCookie("__gads", ".doubleclick.net", { sameSite: "no_restriction", isThirdParty: true }),
      ],
    },
    {
      minutesAgo: 4320,
      label: "cookies-older-profile",
      cookies: [
        makeCookie("watchlist_sort", streaming),
        makeCookie("_ga", streaming),
        makeCookie("segment_trail", ".segment.io", { sameSite: "no_restriction", isThirdParty: true }),
      ],
    },
  ].forEach((cfg) => pushCookies(streaming, cfg));
  [
    {
      minutesAgo: 21,
      kind: "api.canvas.activity",
      surfaceDetail: "canvas",
      domain: "api.segment.io",
      label: "canvas-home-observed",
      data: { operation: "toDataURL", contextType: "2d", width: 1280, height: 720, count: 3, burstMs: 480, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 19,
      kind: "api.canvas.activity",
      surfaceDetail: "canvas",
      domain: "www.googletagmanager.com",
      label: "canvas-player-warned",
      data: { operation: "getImageData", contextType: "2d", width: 640, height: 360, count: 2, burstMs: 220, sampleWindowMs: 1200, gateOutcome: "warned" },
    },
    {
      minutesAgo: 17,
      kind: "api.canvas.activity",
      surfaceDetail: "canvas",
      domain: "connect.facebook.net",
      label: "canvas-blocked",
      data: { operation: "readPixels", contextType: "webgl", width: 1024, height: 512, count: 2, burstMs: 160, sampleWindowMs: 1200, gateOutcome: "blocked" },
    },
    {
      minutesAgo: 310,
      kind: "api.canvas.activity",
      surfaceDetail: "canvas",
      domain: streaming,
      label: "canvas-trusted-allowed",
      data: { operation: "toBlob", contextType: "2d", width: 1920, height: 1080, count: 2, burstMs: 240, sampleWindowMs: 1200, gateOutcome: "trusted_allowed", trustedSite: true },
      isThirdParty: false,
    },
    {
      minutesAgo: 3800,
      kind: "api.canvas.activity",
      surfaceDetail: "canvas",
      domain: "api.mixpanel.com",
      label: "canvas-older-observed",
      data: { operation: "toDataURL", contextType: "2d", width: 300, height: 150, count: 2, burstMs: 120, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 14,
      kind: "api.webrtc.activity",
      surfaceDetail: "webrtc",
      domain: "google.com",
      label: "webrtc-ice-observed",
      data: { action: "ice_candidate_activity", state: "candidate", candidateType: "srflx", stunTurnHostnames: ["stun.l.google.com"], count: 1, burstMs: 0, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 13,
      kind: "api.webrtc.activity",
      surfaceDetail: "webrtc",
      domain: "google.com",
      label: "webrtc-offer-observed",
      data: { action: "offer_created", offerType: "offer", stunTurnHostnames: ["stun.l.google.com"], count: 1, burstMs: 0, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 11,
      kind: "api.webrtc.activity",
      surfaceDetail: "webrtc",
      domain: "google.com",
      label: "webrtc-blocked",
      data: { action: "ice_candidate_activity", state: "candidate", candidateType: "relay", stunTurnHostnames: ["stun.l.google.com"], gateOutcome: "blocked", count: 1, burstMs: 0, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 4000,
      kind: "api.webrtc.activity",
      surfaceDetail: "webrtc",
      domain: streaming,
      label: "webrtc-trusted-allowed",
      data: { action: "set_local_description_offer", offerType: "offer", gateOutcome: "trusted_allowed", trustedSite: true, count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
    {
      minutesAgo: 10,
      kind: "api.clipboard.activity",
      surfaceDetail: "clipboard",
      domain: "api.segment.io",
      label: "clipboard-read-observed",
      data: { method: "readText", accessType: "read", policyReady: true, count: 1, burstMs: 0, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 9,
      kind: "api.clipboard.activity",
      surfaceDetail: "clipboard",
      domain: "connect.facebook.net",
      label: "clipboard-read-blocked",
      data: { method: "readText", accessType: "read", gateOutcome: "blocked", count: 1, burstMs: 0, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 3900,
      kind: "api.clipboard.activity",
      surfaceDetail: "clipboard",
      domain: streaming,
      label: "clipboard-write-allowed",
      data: { method: "writeText", accessType: "write", gateOutcome: "trusted_allowed", trustedSite: true, count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
    {
      minutesAgo: 8,
      kind: "api.geolocation.activity",
      surfaceDetail: "geolocation",
      domain: streaming,
      label: "geo-observed",
      data: { method: "getCurrentPosition", requestedHighAccuracy: true, timeoutMs: 5000, maximumAgeMs: 0, hasSuccessCallback: true, hasErrorCallback: true, count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
    {
      minutesAgo: 7,
      kind: "api.geolocation.activity",
      surfaceDetail: "geolocation",
      domain: streaming,
      label: "geo-blocked",
      data: { method: "watchPosition", requestedHighAccuracy: true, timeoutMs: 3000, maximumAgeMs: 0, hasSuccessCallback: true, hasErrorCallback: true, gateOutcome: "blocked", count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
    {
      minutesAgo: 3700,
      kind: "api.geolocation.activity",
      surfaceDetail: "geolocation",
      domain: streaming,
      label: "geo-trusted-allowed",
      data: { method: "getCurrentPosition", requestedHighAccuracy: false, timeoutMs: 5000, maximumAgeMs: 600000, hasSuccessCallback: true, hasErrorCallback: true, gateOutcome: "trusted_allowed", trustedSite: true, count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
  ].forEach((cfg) => pushApi(streaming, cfg));

  const news = "daily-news.demo.local";
  [
    { minutesAgo: 35, kind: "network.observed", domain: "www.googletagmanager.com", path: "/gtm.js", query: "id=GTM-NEWS01", resourceType: "script", label: "gtm-home" },
    { minutesAgo: 34, kind: "network.observed", domain: "pagead2.googlesyndication.com", path: "/pagead/js/adsbygoogle.js", query: "client=ca-pub-1", resourceType: "script", label: "adsbygoogle" },
    { minutesAgo: 33, kind: "network.blocked", domain: "securepubads.g.doubleclick.net", path: "/gampad/ads", query: "iu=/555/news/home", resourceType: "sub_frame", ruleId: "rule.block.doubleclick", label: "doubleclick-home" },
    { minutesAgo: 32, kind: "network.observed", domain: "widgets.outbrain.com", path: "/outbrain.js", query: "ob_click_id=ob-1", resourceType: "script", label: "outbrain-loader" },
    { minutesAgo: 31, kind: "network.observed", domain: "trc.taboola.com", path: "/taboola.js", query: "tblci=tb-1", resourceType: "script", label: "taboola-loader" },
    { minutesAgo: 29, kind: "network.observed", domain: "clarity.ms", path: "/collect", query: "msclkid=clarity-1&sid=news-a", resourceType: "xmlhttprequest", label: "clarity-session-a" },
    { minutesAgo: 27, kind: "network.observed", domain: "connect.facebook.net", path: "/signals/config.js", query: "id=news-meta", resourceType: "script", label: "meta-config" },
    { minutesAgo: 25, kind: "network.observed", domain: "www.google-analytics.com", path: "/g/collect", query: "cid=news-a&gclid=ad-1&section=politics", resourceType: "xmlhttprequest", label: "ga-politics" },
    { minutesAgo: 23, kind: "network.blocked", domain: "googleadservices.com", path: "/pagead/conversion", query: "label=news-subscribe", resourceType: "image", ruleId: "rule.block.googleadservices", label: "googleadservices-news" },
    { minutesAgo: 21, kind: "network.observed", domain: news, path: "/api/article/lead", query: "section=politics", resourceType: "fetch", isThirdParty: false, label: "article-api" },
    { minutesAgo: 19, kind: "network.observed", domain: "www.googletagmanager.com", path: "/gtm.js", query: "id=GTM-NEWS01&slot=feature", resourceType: "script", label: "gtm-feature" },
    { minutesAgo: 18, kind: "network.blocked", domain: "securepubads.g.doubleclick.net", path: "/gampad/ads", query: "iu=/555/news/article&sz=300x250", resourceType: "sub_frame", ruleId: "rule.block.doubleclick", label: "doubleclick-article" },
    { minutesAgo: 17, kind: "network.observed", domain: "widgets.outbrain.com", path: "/recommendations", query: "ob_click_id=ob-2&article=42", resourceType: "fetch", label: "outbrain-recs" },
    { minutesAgo: 16, kind: "network.observed", domain: "trc.taboola.com", path: "/recommendations", query: "tblci=tb-2&article=42", resourceType: "fetch", label: "taboola-recs" },
    { minutesAgo: 14, kind: "network.observed", domain: "clarity.ms", path: "/collect", query: "msclkid=clarity-2&article=42", resourceType: "xmlhttprequest", label: "clarity-article" },
    { minutesAgo: 13, kind: "network.observed", domain: "www.google-analytics.com", path: "/g/collect", query: "cid=news-b&gclid=ad-2&section=tech", resourceType: "xmlhttprequest", label: "ga-tech" },
    { minutesAgo: 11, kind: "network.blocked", domain: "connect.facebook.net", path: "/en_US/fbevents.js", query: "id=news-retargeting", resourceType: "script", ruleId: "rule.block.meta-pixel", label: "meta-blocked" },
    { minutesAgo: 10, kind: "network.observed", domain: "pagead2.googlesyndication.com", path: "/pagead/gen_204", query: "gclid=ad-3&event=impression", resourceType: "image", label: "adsbygoogle-ping" },
    { minutesAgo: 220, kind: "network.observed", domain: "www.googletagmanager.com", path: "/gtm.js", query: "id=GTM-NEWS01&slot=opinion", resourceType: "script", label: "gtm-opinion" },
    { minutesAgo: 225, kind: "network.blocked", domain: "securepubads.g.doubleclick.net", path: "/gampad/ads", query: "iu=/555/news/opinion", resourceType: "sub_frame", ruleId: "rule.block.doubleclick", label: "doubleclick-opinion" },
    { minutesAgo: 230, kind: "network.observed", domain: "www.google-analytics.com", path: "/g/collect", query: "cid=news-c&gclid=ad-4&section=opinion", resourceType: "xmlhttprequest", label: "ga-opinion" },
    { minutesAgo: 235, kind: "network.observed", domain: "widgets.outbrain.com", path: "/recommendations", query: "ob_click_id=ob-3&article=77", resourceType: "fetch", label: "outbrain-opinion" },
    { minutesAgo: 240, kind: "network.observed", domain: "clarity.ms", path: "/collect", query: "msclkid=clarity-3&article=77", resourceType: "xmlhttprequest", label: "clarity-opinion" },
    { minutesAgo: 245, kind: "network.blocked", domain: "googleadservices.com", path: "/pagead/conversion", query: "label=news-membership", resourceType: "image", ruleId: "rule.block.googleadservices", label: "googleadservices-membership" },
    { minutesAgo: 2600, kind: "network.observed", domain: "www.google-analytics.com", path: "/g/collect", query: "cid=news-older&gclid=archive-1&section=archive", resourceType: "xmlhttprequest", label: "ga-archive" },
    { minutesAgo: 2620, kind: "network.observed", domain: "widgets.outbrain.com", path: "/recommendations", query: "ob_click_id=ob-archive&article=102", resourceType: "fetch", label: "outbrain-archive" },
    { minutesAgo: 2640, kind: "network.blocked", domain: "connect.facebook.net", path: "/signals/config.js", query: "id=archive-meta", resourceType: "script", ruleId: "rule.block.meta-pixel", label: "meta-archive-blocked" },
    { minutesAgo: 5200, kind: "network.observed", domain: "trc.taboola.com", path: "/recommendations", query: "tblci=tb-archive&article=303", resourceType: "fetch", label: "taboola-older" },
    { minutesAgo: 5220, kind: "network.blocked", domain: "securepubads.g.doubleclick.net", path: "/gampad/ads", query: "iu=/555/news/archive", resourceType: "sub_frame", ruleId: "rule.block.doubleclick", label: "doubleclick-archive" },
    { minutesAgo: 5240, kind: "network.observed", domain: news, path: "/api/archive/303", query: "view=full", resourceType: "fetch", isThirdParty: false, label: "archive-first-party" },
  ].forEach((cfg) => pushNetwork(news, { mode: cfg.isThirdParty === false ? "moderate" : "strict", ...cfg }));
  [
    {
      minutesAgo: 24,
      label: "cookies-frontpage",
      cookies: [
        makeCookie("consent_status", news),
        makeCookie("article_meter", news, { secure: false }),
        makeCookie("_ga", news),
        makeCookie("_fbp", ".facebook.com", { sameSite: "no_restriction", isThirdParty: true }),
        makeCookie("ob_uid", ".outbrain.com", { sameSite: "no_restriction", isThirdParty: true }),
        makeCookie("taboola_session", ".taboola.com", { sameSite: "no_restriction", isThirdParty: true }),
      ],
    },
    {
      minutesAgo: 250,
      label: "cookies-article",
      cookies: [
        makeCookie("reader_theme", news),
        makeCookie("_chartbeat2", news),
        makeCookie("__gads", ".doubleclick.net", { sameSite: "no_restriction", isThirdParty: true }),
        makeCookie("_clck", ".clarity.ms", { sameSite: "no_restriction", isThirdParty: true }),
      ],
    },
  ].forEach((cfg) => pushCookies(news, cfg));
  [
    {
      minutesAgo: 20,
      kind: "api.canvas.activity",
      surfaceDetail: "canvas",
      domain: "www.googletagmanager.com",
      label: "canvas-ads-observed",
      data: { operation: "toDataURL", contextType: "2d", width: 300, height: 250, count: 2, burstMs: 140, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 15,
      kind: "api.canvas.activity",
      surfaceDetail: "canvas",
      domain: "securepubads.g.doubleclick.net",
      label: "canvas-ads-blocked",
      data: { operation: "getImageData", contextType: "2d", width: 300, height: 250, count: 2, burstMs: 140, sampleWindowMs: 1200, gateOutcome: "blocked" },
    },
    {
      minutesAgo: 12,
      kind: "api.geolocation.activity",
      surfaceDetail: "geolocation",
      domain: news,
      label: "geo-local-edition",
      data: { method: "getCurrentPosition", requestedHighAccuracy: false, timeoutMs: 8000, maximumAgeMs: 900000, hasSuccessCallback: true, hasErrorCallback: true, count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
    {
      minutesAgo: 18,
      kind: "api.clipboard.activity",
      surfaceDetail: "clipboard",
      domain: "clarity.ms",
      label: "clipboard-read-article",
      data: { method: "readText", accessType: "read", count: 1, burstMs: 0, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 9,
      kind: "api.webrtc.activity",
      surfaceDetail: "webrtc",
      domain: "google.com",
      label: "webrtc-live-update",
      data: { action: "ice_candidate_activity", state: "candidate", candidateType: "srflx", stunTurnHostnames: ["stun.l.google.com"], count: 1, burstMs: 0, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 2605,
      kind: "api.geolocation.activity",
      surfaceDetail: "geolocation",
      domain: news,
      label: "geo-archive-blocked",
      data: { method: "watchPosition", requestedHighAccuracy: true, timeoutMs: 5000, maximumAgeMs: 0, hasSuccessCallback: true, hasErrorCallback: true, gateOutcome: "blocked", count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
  ].forEach((cfg) => pushApi(news, cfg));

  const checkout = "checkout-plus.demo.local";
  [
    { minutesAgo: 45, kind: "network.observed", domain: checkout, path: "/api/cart", query: "cartId=cp-401", resourceType: "fetch", isThirdParty: false, label: "cart-api" },
    { minutesAgo: 43, kind: "network.observed", domain: checkout, path: "/api/pricing", query: "currency=EUR", resourceType: "fetch", isThirdParty: false, label: "pricing-api" },
    { minutesAgo: 42, kind: "network.observed", domain: "www.googletagmanager.com", path: "/gtm.js", query: "id=GTM-CP001", resourceType: "script", label: "gtm-checkout" },
    { minutesAgo: 40, kind: "network.observed", domain: "www.google-analytics.com", path: "/g/collect", query: "cid=checkout-a&step=cart", resourceType: "xmlhttprequest", label: "ga-cart" },
    { minutesAgo: 38, kind: "network.observed", domain: "api.segment.io", path: "/v1/t", query: "ajs_user_id=buyer-1&step=checkout", resourceType: "fetch", label: "segment-checkout" },
    { minutesAgo: 36, kind: "network.observed", domain: "d111111abcdef8.cloudfront.net", path: "/payment-widget.js", query: "widget=card", resourceType: "script", label: "cloudfront-widget" },
    { minutesAgo: 34, kind: "network.blocked", domain: "googleadservices.com", path: "/pagead/conversion", query: "label=post-cart", resourceType: "image", ruleId: "rule.block.googleadservices", label: "googleadservices-postcart" },
    { minutesAgo: 32, kind: "network.observed", domain: "connect.facebook.net", path: "/signals/config.js", query: "id=checkout-meta", resourceType: "script", label: "meta-checkout" },
    { minutesAgo: 30, kind: "network.observed", domain: checkout, path: "/api/review", query: "step=shipping", resourceType: "fetch", isThirdParty: false, label: "review-api" },
    { minutesAgo: 28, kind: "network.blocked", domain: "securepubads.g.doubleclick.net", path: "/gampad/ads", query: "iu=/123/checkout/upsell", resourceType: "sub_frame", ruleId: "rule.block.doubleclick", label: "doubleclick-upsell" },
    { minutesAgo: 26, kind: "network.observed", domain: "api.mixpanel.com", path: "/track/", query: "distinct_id=buyer-1&event=begin_checkout", resourceType: "xmlhttprequest", label: "mixpanel-begin" },
    { minutesAgo: 180, kind: "network.observed", domain: checkout, path: "/api/order-status", query: "order=cp-1", resourceType: "fetch", isThirdParty: false, label: "order-status" },
    { minutesAgo: 183, kind: "network.observed", domain: "api.segment.io", path: "/v1/t", query: "ajs_user_id=buyer-1&step=payment", resourceType: "fetch", label: "segment-payment" },
    { minutesAgo: 186, kind: "network.blocked", domain: "connect.facebook.net", path: "/en_US/fbevents.js", query: "id=checkout-retargeting", resourceType: "script", ruleId: "rule.block.meta-pixel", label: "meta-retargeting-blocked" },
    { minutesAgo: 2900, kind: "network.observed", domain: "www.google-analytics.com", path: "/g/collect", query: "cid=checkout-older&step=confirmation", resourceType: "xmlhttprequest", label: "ga-confirmation" },
    { minutesAgo: 2940, kind: "network.observed", domain: checkout, path: "/api/receipt", query: "order=cp-older", resourceType: "fetch", isThirdParty: false, label: "receipt-first-party" },
  ].forEach((cfg) => pushNetwork(checkout, { mode: cfg.isThirdParty === false ? "moderate" : "moderate", ...cfg }));
  [
    {
      minutesAgo: 41,
      label: "cookies-checkout",
      cookies: [
        makeCookie("__Host-checkout_session", checkout, { httpOnly: true, session: true }),
        makeCookie("currency_pref", checkout),
        makeCookie("_ga", checkout),
        makeCookie("ajs_anonymous_id", ".segment.io", { sameSite: "no_restriction", isThirdParty: true }),
      ],
    },
    {
      minutesAgo: 185,
      label: "cookies-payment",
      cookies: [
        makeCookie("saved_address", checkout, { secure: false }),
        makeCookie("remember_device", checkout),
        makeCookie("mp_checkout", ".mixpanel.com", { sameSite: "no_restriction", isThirdParty: true }),
      ],
    },
  ].forEach((cfg) => pushCookies(checkout, cfg));
  [
    {
      minutesAgo: 37,
      kind: "api.clipboard.activity",
      surfaceDetail: "clipboard",
      domain: checkout,
      label: "clipboard-write-coupon",
      data: { method: "writeText", accessType: "write", count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
    {
      minutesAgo: 35,
      kind: "api.geolocation.activity",
      surfaceDetail: "geolocation",
      domain: checkout,
      label: "geo-shipping-estimate",
      data: { method: "getCurrentPosition", requestedHighAccuracy: false, timeoutMs: 8000, maximumAgeMs: 900000, hasSuccessCallback: true, hasErrorCallback: true, count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
    {
      minutesAgo: 33,
      kind: "api.canvas.activity",
      surfaceDetail: "canvas",
      domain: "api.segment.io",
      label: "canvas-fraud-check",
      data: { operation: "toDataURL", contextType: "2d", width: 320, height: 180, count: 2, burstMs: 90, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 31,
      kind: "api.webrtc.activity",
      surfaceDetail: "webrtc",
      domain: "google.com",
      label: "webrtc-support-chat",
      data: { action: "offer_created", offerType: "offer", stunTurnHostnames: ["stun.l.google.com"], count: 1, burstMs: 0, sampleWindowMs: 1200 },
    },
    {
      minutesAgo: 29,
      kind: "api.canvas.activity",
      surfaceDetail: "canvas",
      domain: checkout,
      label: "canvas-trusted-allowed",
      data: { operation: "toBlob", contextType: "2d", width: 400, height: 200, count: 2, burstMs: 120, sampleWindowMs: 1200, gateOutcome: "trusted_allowed", trustedSite: true },
      isThirdParty: false,
    },
    {
      minutesAgo: 187,
      kind: "api.clipboard.activity",
      surfaceDetail: "clipboard",
      domain: checkout,
      label: "clipboard-read-blocked",
      data: { method: "readText", accessType: "read", gateOutcome: "blocked", count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
  ].forEach((cfg) => pushApi(checkout, cfg));

  const forum = "community-forum.demo.local";
  [
    { minutesAgo: 55, kind: "network.observed", domain: forum, path: "/api/thread/451", query: "sort=top", resourceType: "fetch", isThirdParty: false, label: "thread-api" },
    { minutesAgo: 53, kind: "network.observed", domain: forum, path: "/static/forum.js", query: "v=2", resourceType: "script", isThirdParty: false, label: "forum-js" },
    { minutesAgo: 49, kind: "network.observed", domain: "clarity.ms", path: "/collect", query: "msclkid=forum-1&view=thread", resourceType: "xmlhttprequest", label: "clarity-thread" },
    { minutesAgo: 2400, kind: "network.observed", domain: forum, path: "/api/thread/451/replies", query: "page=2", resourceType: "fetch", isThirdParty: false, label: "replies-api" },
    { minutesAgo: 5000, kind: "network.observed", domain: forum, path: "/api/profile", query: "tab=privacy", resourceType: "fetch", isThirdParty: false, label: "profile-api" },
  ].forEach((cfg) => pushNetwork(forum, { mode: cfg.isThirdParty === false ? "low" : "moderate", ...cfg }));
  pushCookies(forum, {
    minutesAgo: 50,
    label: "cookies-forum",
    mode: "low",
    cookies: [
      makeCookie("forum_session", forum, { httpOnly: true, session: true }),
      makeCookie("locale", forum, { secure: false }),
    ],
  });
  [
    {
      minutesAgo: 48,
      kind: "api.canvas.activity",
      surfaceDetail: "canvas",
      domain: forum,
      label: "canvas-avatar-export",
      mode: "low",
      data: { operation: "toBlob", contextType: "2d", width: 128, height: 128, count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
    {
      minutesAgo: 2450,
      kind: "api.clipboard.activity",
      surfaceDetail: "clipboard",
      domain: forum,
      label: "clipboard-write-snippet",
      mode: "low",
      data: { method: "writeText", accessType: "write", count: 1, burstMs: 0, sampleWindowMs: 1200 },
      isThirdParty: false,
    },
  ].forEach((cfg) => pushApi(forum, cfg));

  return events.sort((a, b) => a.ts - b.ts);
}

module.exports = {
  DUMMY_SOURCE,
  SEEDED_EVENT_ID_PREFIX,
  SEEDED_SITES,
  buildScenarioEvents,
};
