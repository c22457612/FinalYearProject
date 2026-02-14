// public/app/api.js
async function fetchJson(path, options = {}) {
  const res = await fetch(path, options);

  // Handle non-JSON or empty bodies gracefully
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();

  let data = null;
  if (text) {
    if (contentType.includes("application/json")) {
      try {
        data = JSON.parse(text);
      } catch {
        // Keep as raw text if JSON parsing fails
        data = text;
      }
    } else {
      data = text;
    }
  }

  if (!res.ok) {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`HTTP ${res.status} for ${path}: ${msg}`);
  }

  return data;
}

export function getEvents() {
  return fetchJson("/api/events");
}

export function getSites() {
  return fetchJson("/api/sites");
}

export function getPolicies() {
  return fetchJson("/api/policies");
}

export async function fetchDashboardData() {
  const [events, sites, policies] = await Promise.all([
    getEvents(),
    getSites(),
    getPolicies()
  ]);
  return { events, sites, policies };
}

export function postPolicy(op, payload) {
  return fetchJson("/api/policies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, payload })
  });
}
