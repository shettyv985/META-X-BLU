// Shared Meta Ads read-only MCP server, one ad account per client.
// Every Meta call is a GET. Nothing can be created, edited, paused or spent.
//
// Env vars per client, where <KEY> is a short upper-case name such as KENDAMIL or HALWA:
//   META_<KEY>_AD_ACCOUNT_ID   e.g. act_1234567890 (required)
//   META_<KEY>_LABEL           optional display name, e.g. "Halwa Haweli"
//   META_<KEY>_ID_EXAMPLE      optional creative ID example used in ad names, e.g. "HH-012"
//   META_<KEY>_ACCESS_TOKEN    optional; only if this client needs a different token
// Shared:
//   META_ACCESS_TOKEN          system-user token with ONLY ads_read
//   MCP_PATH_KEY               long random secret; URLs only work with it
//   META_API_VERSION           optional, default v23.0
//
// Kendamil keeps working with the old variables: if META_KENDAMIL_AD_ACCOUNT_ID is not set,
// META_AD_ACCOUNT_ID is used for the "kendamil" client.
const crypto = require("crypto");

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DATE_PRESETS = ["today", "yesterday", "last_3d", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "this_month", "last_month", "maximum"];
const INSIGHT_FIELDS = [
  "date_start", "date_stop", "campaign_name", "adset_name", "ad_id", "ad_name",
  "spend", "impressions", "reach", "frequency", "clicks", "inline_link_clicks",
  "ctr", "inline_link_click_ctr", "cpc", "cpm", "actions", "action_values",
  "cost_per_action_type", "purchase_roas", "video_play_actions",
].join(",");

const DEFAULTS = {
  KENDAMIL: { label: "Kendamil Qatar", idExample: "KQ-016", legacyAccountVar: "META_AD_ACCOUNT_ID" },
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function client(key) {
  const k = String(key || "").trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(k)) return null;
  const d = DEFAULTS[k] || {};
  let acct = (process.env[`META_${k}_AD_ACCOUNT_ID`] || (d.legacyAccountVar && process.env[d.legacyAccountVar]) || "").trim();
  if (!acct) return null;
  if (!acct.startsWith("act_")) acct = "act_" + acct;
  return {
    key: k.toLowerCase(),
    acct,
    label: process.env[`META_${k}_LABEL`] || d.label || k.charAt(0) + k.slice(1).toLowerCase(),
    idExample: process.env[`META_${k}_ID_EXAMPLE`] || d.idExample || "",
    token: process.env[`META_${k}_ACCESS_TOKEN`] || process.env.META_ACCESS_TOKEN || "",
  };
}

function tools(c) {
  const idHint = c.idExample ? ` Ad names contain the creative ID (e.g. '${c.idExample}').` : "";
  const filterEg = c.idExample ? `e.g. '${c.idExample}' or ' AR'` : "e.g. part of an ad name";
  return [
    {
      name: "get_account_overview",
      description: `${c.label} ad account: name, currency, time zone, status and total spend/results for a period.`,
      inputSchema: { type: "object", properties: { date_preset: { type: "string", enum: DATE_PRESETS, description: "Period. Default last_7d." } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_ad_performance",
      description: `${c.label}: performance per ad (or adset/campaign) for a period: spend, impressions, reach, clicks, link clicks, CTR, CPC, CPM, purchases, purchase value, ROAS, plus every other result Meta reports (all_actions, all_action_values, cost_per_action): leads, initiate checkout, registrations, subscriptions, app installs, custom events and custom conversions (shown with their names).${idHint} Use name_contains to filter.`,
      inputSchema: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["ad", "adset", "campaign"], description: "Default ad." },
          date_preset: { type: "string", enum: DATE_PRESETS, description: "Default last_7d. Ignored if since/until given." },
          since: { type: "string", description: "YYYY-MM-DD (use with until)." },
          until: { type: "string", description: "YYYY-MM-DD (use with since)." },
          daily: { type: "boolean", description: "true = one row per day per item." },
          breakdown: { type: "string", enum: ["age", "gender", "publisher_platform", "platform_position", "region", "device_platform"], description: "Optional breakdown." },
          name_contains: { type: "string", description: `Only rows whose ad/adset/campaign name contains this text, ${filterEg}.` },
          limit: { type: "integer", description: "Max rows returned (default 200, max 1000)." },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "list_custom_conversions",
      description: `${c.label}: custom conversions on the account (id, name, event type, rule, last fired, pixel). Their results appear in get_ad_performance as offsite_conversion.custom.<id>.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "list_pixels",
      description: `${c.label}: Meta pixels/datasets on the ad account and when each last received an event. Use it to check whether events are firing at all.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "list_ads",
      description: `List ${c.label} ads with status, dates and creative text/image (headline, primary text, image URL).${c.idExample ? " Use to match ads to creative IDs." : ""}`,
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
}

async function graphGet(c, path, params, maxRows = 1000) {
  if (!c.token) throw new Error("Server not configured: set META_ACCESS_TOKEN in Vercel.");
  const url = new URL(`https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}/${path}`);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  url.searchParams.set("access_token", c.token);
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

// Every action type Meta returned, as { action_type: number }. Custom conversions
// (offsite_conversion.custom.<id>) get their name appended when it is known.
function allOf(list, names) {
  if (!Array.isArray(list) || !list.length) return undefined;
  const out = {};
  for (const x of list) {
    let k = x.action_type;
    const m = /^offsite_conversion\.custom\.(\d+)$/.exec(k);
    if (m && names && names[m[1]]) k = `${k} (${names[m[1]]})`;
    out[k] = Number(x.value);
  }
  return out;
}

function tidy(row, names) {
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
    // Common non-purchase results, picked out for convenience
    leads: pick(row.actions, ["lead"]),
    initiate_checkout: pick(row.actions, ["initiate_checkout"]),
    complete_registration: pick(row.actions, ["complete_registration"]),
    subscribe: pick(row.actions, ["subscribe"]),
    app_installs: pick(row.actions, ["mobile_app_install", "app_install"]),
    custom_events: pick(row.actions, ["offsite_conversion.fb_pixel_custom"]),
    custom_conversions: allOf((row.actions || []).filter(x => /^offsite_conversion\.custom\./.test(x.action_type)), names),
    // Full lists exactly as Meta returned them (every event, standard and custom)
    all_actions: allOf(row.actions, names),
    all_action_values: allOf(row.action_values, names),
    cost_per_action: allOf(row.cost_per_action_type, names),
  };
}

// Custom conversion id -> name for the account. Empty if the token can't read them.
async function conversionNames(c) {
  try {
    const list = await graphGet(c, `${c.acct}/customconversions`, { fields: "id,name", limit: 200 }, 1000);
    const out = {}; for (const x of list) out[x.id] = x.name; return out;
  } catch { return {}; }
}

async function callTool(c, name, a = {}) {
  const acct = c.acct;
  if (name === "get_account_overview") {
    const info = await graphGet(c, acct, { fields: "name,currency,timezone_name,account_status,amount_spent" });
    const [tot, names] = await Promise.all([
      graphGet(c, `${acct}/insights`, { level: "account", fields: INSIGHT_FIELDS, ...timeParams(a) }),
      conversionNames(c),
    ]);
    return { account: info, period: a.date_preset || "last_7d", totals: Array.isArray(tot) ? tot.map(r => tidy(r, names)) : tot };
  }
  if (name === "get_ad_performance") {
    const level = ["ad", "adset", "campaign"].includes(a.level) ? a.level : "ad";
    const limit = Math.min(Math.max(parseInt(a.limit || 200, 10), 1), 1000);
    const p = { level, fields: INSIGHT_FIELDS, limit: 500, ...timeParams(a) };
    if (a.daily) p.time_increment = 1;
    if (a.breakdown) p.breakdowns = a.breakdown;
    if (a.name_contains) p.filtering = [{ field: `${level}.name`, operator: "CONTAIN", value: a.name_contains }];
    const [rows, names] = await Promise.all([graphGet(c, `${acct}/insights`, p, limit), conversionNames(c)]);
    return { level, rows: rows.map(r => tidy(r, names)) };
  }
  if (name === "list_ads") {
    const limit = Math.min(Math.max(parseInt(a.limit || 100, 10), 1), 500);
    const p = { fields: "id,name,effective_status,created_time,updated_time,adset{name},campaign{name},creative{title,body,image_url,thumbnail_url,object_story_spec,asset_feed_spec}", limit: 100 };
    const filters = [];
    if (a.status && a.status !== "ALL") filters.push({ field: "effective_status", operator: "IN", value: [a.status] });
    else filters.push({ field: "effective_status", operator: "NOT_IN", value: ["DELETED", "ARCHIVED"] });
    if (a.name_contains) filters.push({ field: "name", operator: "CONTAIN", value: a.name_contains });
    p.filtering = filters;
    const ads = await graphGet(c, `${acct}/ads`, p, limit);
    return {
      ads: ads.map(ad => {
        const cr = ad.creative || {};
        const link = (cr.object_story_spec && cr.object_story_spec.link_data) || {};
        return {
          id: ad.id, name: ad.name, status: ad.effective_status, created: ad.created_time, updated: ad.updated_time,
          campaign: ad.campaign && ad.campaign.name, adset: ad.adset && ad.adset.name,
          headline: cr.title || link.name, primary_text: cr.body || link.message,
          image_url: cr.image_url || link.picture || cr.thumbnail_url,
        };
      }),
    };
  }
  if (name === "list_custom_conversions") {
    const list = await graphGet(c, `${acct}/customconversions`, { fields: "id,name,custom_event_type,rule,is_archived,last_fired_time,pixel{id,name}", limit: 200 }, 1000);
    return { custom_conversions: list.map(x => ({ id: x.id, name: x.name, event_type: x.custom_event_type, rule: x.rule, archived: x.is_archived,
      last_fired: x.last_fired_time, pixel: x.pixel && x.pixel.name, action_type: `offsite_conversion.custom.${x.id}` })) };
  }
  if (name === "list_pixels") {
    const list = await graphGet(c, `${acct}/adspixels`, { fields: "id,name,last_fired_time,is_unavailable", limit: 50 }, 200);
    return { pixels: list.map(x => ({ id: x.id, name: x.name, last_fired: x.last_fired_time, unavailable: x.is_unavailable })),
      note: "last_fired is when the pixel last received any event. If a pixel is missing or the call fails, assign the dataset to the system user (Business Settings → Data sources → Datasets → Assign → View)." };
  }
  throw new Error(`Unknown tool: ${name}`);
}

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMessage(c, msg) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null; // notification: no response
  try {
    if (method === "initialize") {
      const v = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(v) ? v : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `${c.key}-meta-ads`, version: "1.2.0" },
        instructions: `Read-only Meta Ads data for the ${c.label} ad account.${c.idExample ? ` Ad names carry the creative ID (e.g. ${c.idExample}).` : ""}`,
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

// Vercel handler. clientKey comes from the URL (/api/meta/<client>/<key>) or is fixed (old Kendamil URL).
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

module.exports = { serve, client, tools, handleMessage, callTool, tidy };
