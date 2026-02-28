/**
 * Key-name taxonomy for potential data-sharing inventory.
 * Maps (surface, keyName) -> { data_category, key_confidence }.
 *
 * Notes:
 * - Key-name inference only. Never inspects raw values.
 * - Rules are ordered from more specific to broader.
 */

const TAXONOMY_RULES = [
  // Session/auth style tokens.
  {
    id: "session_token_key",
    surfaces: ["network"],
    data_category: "session_tokens",
    key_confidence: 0.95,
    pattern: /(^|[_\-.])(session(id)?|sess(id)?|token|auth(token)?|access_token|refresh_token|jwt|sid|phpsessid|csrf|xsrf)([_\-.]|$)/i,
  },
  // Analytics/linking identifiers.
  {
    id: "analytics_id_key",
    surfaces: ["network"],
    data_category: "analytics_ids",
    key_confidence: 0.92,
    pattern: /(^|[_\-.])(_ga|ga(id|cid)?|gclid|fbclid|msclkid|client(id)?|amplitude(id)?|mixpanel(id)?|segment(id)?|cid)([_\-.]|$)/i,
  },
  // Ad-tech identifiers/click IDs.
  {
    id: "advertising_id_key",
    surfaces: ["network"],
    data_category: "advertising_ids",
    key_confidence: 0.9,
    pattern: /(^|[_\-.])(ad(id|vertisingid)?|aaid|idfa|clickid|dclid|ttclid|yclid|campaignid|creativeid|aff(id)?|irclickid)([_\-.]|$)/i,
  },
  // Contact-like fields inferred by key name only.
  {
    id: "contact_like_key",
    surfaces: ["network"],
    data_category: "contact_like",
    key_confidence: 0.78,
    pattern: /(^|[_\-.])(email|e?mail|phone|mobile|msisdn|tel)([_\-.]|$)/i,
  },
  // Location-like fields inferred by key name only.
  {
    id: "location_like_key",
    surfaces: ["network"],
    data_category: "location_like",
    key_confidence: 0.76,
    pattern: /(^|[_\-.])(lat|latitude|lon|lng|longitude|geo)([_\-.]|$)/i,
  },
  // Broad identifier-like fields.
  {
    id: "identifier_key",
    surfaces: ["network"],
    data_category: "identifiers",
    key_confidence: 0.72,
    pattern: /(^|[_\-.])(id|uid|guid|uuid|user(id)?|device(id)?|account(id)?|member(id)?)([_\-.]|$)/i,
  },
];

function normalizeKeyName(keyName) {
  const raw = String(keyName || "").trim();
  if (!raw) return "";
  return raw.replace(/\[\]$/g, "").replace(/\s+/g, "_");
}

function classifyExposureKey(surface, keyName) {
  const normalizedSurface = String(surface || "unknown").trim().toLowerCase();
  const normalizedKey = normalizeKeyName(keyName);
  if (!normalizedKey) return null;

  for (const rule of TAXONOMY_RULES) {
    if (Array.isArray(rule.surfaces) && !rule.surfaces.includes(normalizedSurface)) {
      continue;
    }
    if (!rule.pattern.test(normalizedKey)) continue;
    return {
      data_category: rule.data_category,
      key_confidence: rule.key_confidence,
      rule_id: rule.id,
    };
  }
  return null;
}

module.exports = {
  TAXONOMY_RULES,
  normalizeKeyName,
  classifyExposureKey,
};
