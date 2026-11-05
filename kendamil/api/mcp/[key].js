// Kendamil Qatar – Meta Ads read-only MCP server (Vercel serverless function).
// Endpoint: https://<project>.vercel.app/api/mcp/<MCP_PATH_KEY>
// Env vars (set in Vercel → Project → Settings → Environment Variables):
//   META_ACCESS_TOKEN   System-user token with ONLY the ads_read permission
//   META_AD_ACCOUNT_ID  e.g. act_1234567890 (the Kendamil Qatar ad account)
//   MCP_PATH_KEY        long random string; the URL only works with it
//   META_API_VERSION    optional, default v23.0
// Read-only by design: every Meta call is a GET. Nothing can be created, edited or paused.

const SERVER_INFO = { name: "kendamil-meta-ads", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSIGHT_FIELDS = [
  "date_start", "date_stop", "campaign_name", "adset_name", "ad_id", "ad_name",
  "spend", "impressions", "reach", "frequency", "clicks", "inline_link_clicks",
  "ctr", "inline_link_click_ctr", "cpc", "cpm", "actions", "action_values",
  "cost_per_action_type", "purchase_roas", "video_play_actions",
].join(",");

const DATE_PRESETS = ["today", "yesterday", "last_3d", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "this_month", "last_month", "maximum"];

const TOOLS = [
  {
    name: "get_account_overview",
    description: "Kendamil Qatar ad account: name, currency, time zone, status and total spend/results for a period.",
    inputSchema: {
      type: "object",
      properties: {
        date_preset: { type: "string", enum: DATE_PRESETS, description: "Period. Default last_7d." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_ad_performance",
    description: "Performance per ad (or adset/campaign) for a period: spend, impressions, reach, clicks, link clicks, CTR, CPC, CPM, purchases, purchase value, ROAS. Ad names contain the KQ creative ID (e.g. 'KQ-016'). Use name_contains to filter.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["ad", "adset", "campaign"], description: "Default ad." },
        date_preset: { type: "string", enum: DATE_PRESETS, description: "Default last_7d. Ignored if since/until given." },
        since: { type: "string", description: "YYYY-MM-DD (use with until)." },
        until: { type: "string", description: "YYYY-MM-DD (use with since)." },
        daily: { type: "boolean", description: "true = one row per day per item." },
        breakdown: { type: "string", enum: ["age", "gender", "publisher_platform", "platform_position", "region", "device_platform"], description: "Optional breakdown." },
        name_contains: { type: "string", description: "Only rows whose ad/adset/campaign name contains this text, e.g. 'KQ-016' or ' AR'." },
        limit: { type: "integer", description: "Max rows returned (default 200, max 1000)." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_ads",
    description: "List ads in the account with status, dates and creative text/image (headline, primary text, image URL). Use to match ads to KQ creative IDs.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ACTIVE", "PAUSED", "ALL"], description: "Default ALL (excluding deleted/archived)." },
        name_contains: { type: "string" },
        limit: { type: "integer", description: "Default 100, max 500." },
      },
    },
    annotations: { readOnlyHint: true },
  },
];

function cfg() {
  const token = process.env.META_ACCESS_TOKEN;
  let acct = (process.env.META_AD_ACCOUNT_ID || "").trim();
  if (acct && !acct.startsWith("act_")) acct = "act_" + acct;
  const ver = process.env.META_API_VERSION || "v23.0";
  if (!token || !acct) throw new Error("Server not configured: set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in Vercel.");
  return { token, acct, base: `https://graph.facebook.com/${ver}` };
}

async function graphGet(path, params, maxRows = 1000) {
  const { token, base } = cfg();
  const url = new URL(`${base}/${path}`);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  url.searchParams.set("access_token", token);
  let next = url.toString();
  const rows = [];
  let single = null;
  while (next && rows.length < maxRows) {
    const r = await fetch(next);
    const body = await r.json();
    if (body.error) throw new Error(`Meta API: ${body.error.message} (code ${body.error.code})`);
    if (!Array.isArray(body.data)) { single = body; break; }
    rows.push(...body.data);
    next = body.paging && body.paging.next;
  }
  return single || rows.slice(0, maxRows);
}

function timeParams(a) {
  if (a.since && a.until) return { time_range: { since: a.since, until: a.until } };
  return { date_preset: DATE_PRESETS.includes(a.date_preset) ? a.date_preset : "last_7d" };
}

function pick(list, types) {
  if (!Array.isArray(list)) return undefined;
  const out = {};
  for (const x of list) if (types.some(t => x.action_type === t || x.action_type.endsWith(t))) out[x.action_type] = Number(x.value);
  return Object.keys(out).length ? out : undefined;
}

function tidy(row) {
  const num = k => (row[k] !== undefined ? Number(row[k]) : undefined);
  const purchaseTypes = ["purchase", "offsite_conversion.fb_pixel_purchase", "omni_purchase"];
  return {
    date_start: row.date_start, date_stop: row.date_stop,
    campaign: row.campaign_name, adset: row.adset_name, ad_id: row.ad_id, ad: row.ad_name,
    age: row.age, gender: row.gender, platform: row.publisher_platform, position: row.platform_position, region: row.region, device: row.device_platform,
    spend: num("spend"), impressions: num("impressions"), reach: num("reach"), frequency: num("frequency"),
    clicks: num("clicks"), link_clicks: num("inline_link_clicks"), ctr_pct: num("ctr"), link_ctr_pct: num("inline_link_click_ctr"),
    cpc: num("cpc"), cpm: num("cpm"),
    purchases: pick(row.actions, purchaseTypes),
    purchase_value: pick(row.action_values, purchaseTypes),
    add_to_cart: pick(row.actions, ["add_to_cart"]),
    landing_page_views: pick(row.actions, ["landing_page_view"]),
    roas: pick(row.purchase_roas, purchaseTypes),
  };
}

async function callTool(name, a = {}) {
  const { acct } = cfg();
  if (name === "get_account_overview") {
    const info = await graphGet(acct, { fields: "name,currency,timezone_name,account_status,amount_spent" });
    const tot = await graphGet(`${acct}/insights`, { level: "account", fields: INSIGHT_FIELDS, ...timeParams(a) });
    return { account: info, period: a.date_preset || "last_7d", totals: Array.isArray(tot) ? tot.map(tidy) : tot };
  }
  if (name === "get_ad_performance") {
    const level = ["ad", "adset", "campaign"].includes(a.level) ? a.level : "ad";
    const limit = Math.min(Math.max(parseInt(a.limit || 200, 10), 1), 1000);
    const p = { level, fields: INSIGHT_FIELDS, limit: 500, ...timeParams(a) };
    if (a.daily) p.time_increment = 1;
    if (a.breakdown) p.breakdowns = a.breakdown;
    if (a.name_contains) p.filtering = [{ field: `${level}.name`, operator: "CONTAIN", value: a.name_contains }];
    const rows = await graphGet(`${acct}/insights`, p, limit);
    return { level, rows: rows.map(tidy) };
  }
  if (name === "list_ads") {
    const limit = Math.min(Math.max(parseInt(a.limit || 100, 10), 1), 500);
    const p = { fields: "id,name,effective_status,created_time,updated_time,adset{name},campaign{name},creative{title,body,image_url,thumbnail_url,object_story_spec,asset_feed_spec}", limit: 100 };
    const filters = [];
    if (a.status && a.status !== "ALL") filters.push({ field: "effective_status", operator: "IN", value: [a.status] });
    else filters.push({ field: "effective_status", operator: "NOT_IN", value: ["DELETED", "ARCHIVED"] });
    if (a.name_contains) filters.push({ field: "name", operator: "CONTAIN", value: a.name_contains });
    p.filtering = filters;
    const ads = await graphGet(`${acct}/ads`, p, limit);
    return {
      ads: ads.map(ad => {
        const c = ad.creative || {};
        const link = (c.object_story_spec && c.object_story_spec.link_data) || {};
        return {
          id: ad.id, name: ad.name, status: ad.effective_status, created: ad.created_time, updated: ad.updated_time,
          campaign: ad.campaign && ad.campaign.name, adset: ad.adset && ad.adset.name,
          headline: c.title || link.name, primary_text: c.body || link.message,
          image_url: c.image_url || link.picture || c.thumbnail_url,
        };
      }),
    };
  }
  throw new Error(`Unknown tool: ${name}`);
}

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handleMessage(msg) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null; // notification: no response
  try {
    if (method === "initialize") {
      const v = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(v) ? v : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Read-only Meta Ads data for the Kendamil Qatar ad account. Ad names carry the KQ creative ID.",
      });
    }
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
    if (method === "tools/call") {
      try {
        const out = await callTool(params && params.name, (params && params.arguments) || {});
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
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

module.exports = async function handler(req, res) {
  const expected = process.env.MCP_PATH_KEY;
  const key = (req.query && req.query.key) || "";
  if (!expected || key !== expected) { res.statusCode = 404; return res.end("Not found"); }
  if (req.method === "GET") { res.statusCode = 405; res.setHeader("Allow", "POST"); return res.end(); }
  if (req.method === "DELETE") { res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  let body;
  try { body = await readBody(req); } catch { res.statusCode = 400; res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify(rpcError(null, -32700, "Parse error"))); }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(handleMessage))).filter(Boolean);
  if (!replies.length) { res.statusCode = 202; return res.end(); }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(batch ? replies : replies[0]));
};

module.exports._internal = { handleMessage, callTool, tidy };
