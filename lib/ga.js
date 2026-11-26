// Shared Google Analytics 4 read-only MCP server, one GA4 property per client.
// Uses the GA4 Data API with a service account that has only the Viewer role on each property.
// Nothing can be created, edited or deleted.
//
// Env vars per client, where <KEY> is a short upper-case name such as ASHWIN:
//   GA_<KEY>_PROPERTY_ID   numeric GA4 property ID, e.g. 565267513 (required)
//   GA_<KEY>_LABEL         optional display name, e.g. "House of Ashwin Crystals"
// Shared:
//   GA_SA_KEY_JSON         the service account's JSON key (whole file contents)
//   MCP_PATH_KEY           same secret as the Meta/Shopify connectors
const crypto = require("crypto");

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DATE_PRESETS = ["today", "yesterday", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "this_month", "last_month", "last_12_months"];
const API = "https://analyticsdata.googleapis.com/v1beta";

const BREAKDOWNS = {
  channel: ["sessionDefaultChannelGroup"],
  source_medium: ["sessionSourceMedium"],
  campaign: ["sessionCampaignName"],
  page: ["pagePath", "pageTitle"],
  landing_page: ["landingPagePlusQueryString"],
  country: ["country"],
  city: ["city"],
  device: ["deviceCategory"],
  new_vs_returning: ["newVsReturning"],
  event: ["eventName"],
  product: ["itemName"],
  date: ["date"],
};
const TRAFFIC_METRICS = ["sessions", "totalUsers", "newUsers", "engagedSessions", "engagementRate", "averageSessionDuration", "screenPageViews", "keyEvents", "transactions", "purchaseRevenue"];
const METRICS_FOR = {
  page: ["screenPageViews", "totalUsers", "userEngagementDuration", "keyEvents"],
  event: ["eventCount", "totalUsers", "eventValue"],
  product: ["itemsViewed", "itemsAddedToCart", "itemsPurchased", "itemRevenue"],
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function client(key) {
  const k = String(key || "").trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(k)) return null;
  const prop = String(process.env[`GA_${k}_PROPERTY_ID`] || "").replace(/\D/g, "");
  if (!prop) return null;
  return { key: k.toLowerCase(), property: `properties/${prop}`, label: process.env[`GA_${k}_LABEL`] || k.charAt(0) + k.slice(1).toLowerCase() };
}

// ---- Service account auth (signed JWT -> OAuth access token), cached per instance ----
let cached = { token: "", exp: 0 };
function saKey() {
  const raw = process.env.GA_SA_KEY_JSON;
  if (!raw) throw new Error("GA_SA_KEY_JSON is not set in Vercel.");
  let k;
  try { k = JSON.parse(raw); } catch { throw new Error("GA_SA_KEY_JSON is not valid JSON. Paste the whole key file."); }
  if (!k.client_email || !k.private_key) throw new Error("GA_SA_KEY_JSON is missing client_email or private_key.");
  return k;
}
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.exp - 60 > now) return cached.token;
  const k = saKey();
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: k.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(k.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google auth failed: ${j.error_description || j.error || r.status}`);
  cached = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return cached.token;
}
async function gaPost(path, body) {
  const r = await fetch(`${API}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google Analytics API: ${(j.error && j.error.message) || r.status}`);
  return j;
}

// ---- Dates (property time zone is applied by GA) ----
function range(a) {
  if (a.start_date || a.end_date) return { startDate: a.start_date || "7daysAgo", endDate: a.end_date || "today" };
  const p = a.date_preset || "last_7d";
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const ymd = d => d.toISOString().slice(0, 10);
  switch (p) {
    case "today": return { startDate: "today", endDate: "today" };
    case "yesterday": return { startDate: "yesterday", endDate: "yesterday" };
    case "last_14d": return { startDate: "14daysAgo", endDate: "yesterday" };
    case "last_28d": return { startDate: "28daysAgo", endDate: "yesterday" };
    case "last_30d": return { startDate: "30daysAgo", endDate: "yesterday" };
    case "last_90d": return { startDate: "90daysAgo", endDate: "yesterday" };
    case "last_12_months": return { startDate: "365daysAgo", endDate: "yesterday" };
    case "this_month": return { startDate: ymd(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1))), endDate: "today" };
    case "last_month": return { startDate: ymd(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1))), endDate: ymd(new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 0))) };
    default: return { startDate: "7daysAgo", endDate: "yesterday" };
  }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : v; }
function rowsOut(rep) {
  const dh = (rep.dimensionHeaders || []).map(h => h.name), mh = (rep.metricHeaders || []).map(h => h.name);
  return (rep.rows || []).map(r => {
    const o = {};
    dh.forEach((n, i) => { o[n] = r.dimensionValues[i].value; });
    mh.forEach((n, i) => { o[n] = num(r.metricValues[i].value); });
    return o;
  });
}
function filterExpr(dimension, contains) {
  return contains ? { filter: { fieldName: dimension, stringFilter: { matchType: "CONTAINS", value: contains, caseSensitive: false } } } : undefined;
}

const dateProps = {
  date_preset: { type: "string", enum: DATE_PRESETS, description: "Period. Default last_7d (the 7 full days before today)." },
  start_date: { type: "string", description: "YYYY-MM-DD or GA relative date like 30daysAgo. Overrides date_preset." },
  end_date: { type: "string", description: "YYYY-MM-DD, 'today' or 'yesterday'." },
};

function tools(c) {
  return [
    {
      name: "get_overview",
      description: `${c.label} website (Google Analytics 4): totals for a period — sessions, users, new users, engaged sessions, engagement rate, average session duration, page views, key events (conversions), transactions and purchase revenue — plus the same for the previous period of equal length for comparison.`,
      inputSchema: { type: "object", properties: { ...dateProps } },
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_breakdown",
      description: `${c.label} website (GA4): top rows broken down by one dimension — channel (Organic Search, Paid Social, Direct…), source_medium, campaign (UTM campaign), page, landing_page, country, city, device, new_vs_returning, event, product (e-commerce items), or date (daily trend). Returns the matching metrics per row, sorted by the main metric.`,
      inputSchema: {
        type: "object",
        properties: {
          by: { type: "string", enum: Object.keys(BREAKDOWNS), description: "What to break down by." },
          ...dateProps,
          contains: { type: "string", description: "Optional: only rows whose value contains this text (e.g. 'instagram', '/products/')." },
          limit: { type: "integer", description: "Max rows (default 25, max 250)." },
        },
        required: ["by"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_realtime",
      description: `${c.label} website (GA4): active users in the last 30 minutes, by country, device and page/screen.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "run_report",
      description: `${c.label} website (GA4): advanced custom report with any GA4 Data API dimension and metric names (e.g. dimensions ["sessionSource","deviceCategory"], metrics ["sessions","purchaseRevenue"]). Use get_overview / get_breakdown first; use this only for combinations they don't cover.`,
      inputSchema: {
        type: "object",
        properties: {
          dimensions: { type: "array", items: { type: "string" }, description: "Up to 9 GA4 dimension API names." },
          metrics: { type: "array", items: { type: "string" }, description: "1-10 GA4 metric API names." },
          ...dateProps,
          order_by_metric: { type: "string", description: "Optional metric to sort by, descending." },
          limit: { type: "integer", description: "Max rows (default 100, max 1000)." },
        },
        required: ["metrics"],
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

function prevRange(r) {
  // Only for absolute dates; GA accepts NdaysAgo so build comparable relative ranges.
  const rel = s => { const m = /^(\d+)daysAgo$/.exec(s); return s === "today" ? 0 : s === "yesterday" ? 1 : m ? Number(m[1]) : null; };
  const a = rel(r.startDate), b = rel(r.endDate);
  if (a !== null && b !== null) { const len = a - b + 1; return { startDate: `${a + len}daysAgo`, endDate: `${b + len}daysAgo` }; }
  const s = new Date(r.startDate + "T00:00:00Z"), e = new Date((r.endDate === "today" ? new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10) : r.endDate) + "T00:00:00Z");
  if (isNaN(s) || isNaN(e)) return null;
  const len = Math.round((e - s) / 86400000) + 1;
  const ymd = d => d.toISOString().slice(0, 10);
  return { startDate: ymd(new Date(s - len * 86400000)), endDate: ymd(new Date(s - 86400000)) };
}

async function callTool(c, name, a) {
  a = a || {};
  if (name === "get_overview") {
    const r = range(a), p = prevRange(r);
    const dateRanges = p ? [{ ...r, name: "current" }, { ...p, name: "previous" }] : [{ ...r, name: "current" }];
    const rep = await gaPost(`${c.property}:runReport`, { dateRanges, metrics: TRAFFIC_METRICS.map(name => ({ name })) });
    const rows = rowsOut(rep);
    const pick = n => rows.find(x => x.dateRange === n) || (n === "current" && rows.length === 1 ? rows[0] : undefined);
    const strip = o => { if (!o) return o; const x = { ...o }; delete x.dateRange; return x; };
    return { property: c.label, period: r, current: strip(pick("current")) || {}, previous_period: p ? { ...p, ...(strip(pick("previous")) || {}) } : undefined,
      note: "averageSessionDuration is in seconds; engagementRate is a fraction (0.62 = 62%); purchaseRevenue is in the property's currency." };
  }
  if (name === "get_breakdown") {
    const dims = BREAKDOWNS[a.by];
    if (!dims) throw new Error(`Unknown 'by'. Use one of: ${Object.keys(BREAKDOWNS).join(", ")}`);
    const metrics = METRICS_FOR[a.by] || ["sessions", "totalUsers", "newUsers", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"];
    const limit = Math.min(Math.max(parseInt(a.limit || 25, 10), 1), 250);
    const body = {
      dateRanges: [range(a)], dimensions: dims.map(name => ({ name })), metrics: metrics.map(name => ({ name })), limit,
      orderBys: a.by === "date" ? [{ dimension: { dimensionName: "date" } }] : [{ metric: { metricName: metrics[0] }, desc: true }],
    };
    const f = filterExpr(dims[0], a.contains);
    if (f) body.dimensionFilter = f;
    const rep = await gaPost(`${c.property}:runReport`, body);
    return { property: c.label, by: a.by, period: range(a), rows: rowsOut(rep), total_rows: rep.rowCount || 0 };
  }
  if (name === "get_realtime") {
    const q = dims => gaPost(`${c.property}:runRealtimeReport`, { dimensions: dims.map(name => ({ name })), metrics: [{ name: "activeUsers" }], limit: 15, orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }] });
    const [tot, country, device, page] = await Promise.all([
      gaPost(`${c.property}:runRealtimeReport`, { metrics: [{ name: "activeUsers" }] }), q(["country"]), q(["deviceCategory"]), q(["unifiedScreenName"]),
    ]);
    const t = rowsOut(tot)[0] || {};
    return { property: c.label, active_users_last_30_min: t.activeUsers || 0, by_country: rowsOut(country), by_device: rowsOut(device), by_page: rowsOut(page) };
  }
  if (name === "run_report") {
    const metrics = (a.metrics || []).slice(0, 10), dims = (a.dimensions || []).slice(0, 9);
    if (!metrics.length) throw new Error("Give at least one metric.");
    const body = { dateRanges: [range(a)], dimensions: dims.map(name => ({ name })), metrics: metrics.map(name => ({ name })), limit: Math.min(Math.max(parseInt(a.limit || 100, 10), 1), 1000) };
    if (a.order_by_metric) body.orderBys = [{ metric: { metricName: a.order_by_metric }, desc: true }];
    const rep = await gaPost(`${c.property}:runReport`, body);
    return { property: c.label, period: range(a), rows: rowsOut(rep), total_rows: rep.rowCount || 0 };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handleMessage(c, msg) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null;
  try {
    if (method === "initialize") {
      const v = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(v) ? v : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `${c.key}-google-analytics`, version: "1.0.0" },
        instructions: `Read-only Google Analytics 4 data for the ${c.label} website: traffic, sources, pages, countries, devices, conversions and e-commerce. Start with get_overview or get_breakdown.`,
      });
    }
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: tools(c) });
    if (method === "tools/call") {
      try {
        const out = await callTool(c, params && params.name, (params && params.arguments) || {});
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        return rpcResult(id, { content: [{ type: "text", text: String(e.message || e) }], isError: true });
      }
    }
    if (method === "resources/list") return rpcResult(id, { resources: [] });
    if (method === "prompts/list") return rpcResult(id, { prompts: [] });
    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    return rpcError(id, -32603, String(e.message || e));
  }
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

async function serve(req, res, clientKey) {
  const expected = process.env.MCP_PATH_KEY;
  if (!expected || !safeEqual((req.query && req.query.key) || "", expected)) { res.statusCode = 404; return res.end("Not found"); }
  const c = client(clientKey);
  if (!c) { res.statusCode = 404; return res.end("Not found"); }
  if (req.method === "GET") { res.statusCode = 405; res.setHeader("Allow", "POST"); return res.end(); }
  if (req.method === "DELETE") { res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  let body;
  try { body = await readBody(req); } catch { res.statusCode = 400; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify(rpcError(null, -32700, "Parse error"))); }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(m => handleMessage(c, m)))).filter(Boolean);
  if (!replies.length) { res.statusCode = 202; return res.end(); }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(batch ? replies : replies[0]));
}

module.exports = { serve, client, tools, handleMessage, callTool, range, prevRange };
