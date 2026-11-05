// Blusteak Shopify read-only MCP server.
// Endpoint: https://<project>.vercel.app/api/shopify/mcp/<MCP_PATH_KEY>
// Every Shopify call is a read query; there are no mutations anywhere in this file.
const { storeKeys, store, safeEqual, gql } = require("../../../lib/shopify");

const SERVER_INFO = { name: "blu-shopify", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const STORE_PROP = { store: { type: "string", description: "Store key from list_stores, e.g. 'kendamil'." } };
const DATE_PROPS = {
  since: { type: "string", description: "YYYY-MM-DD (store time). Default: 30 days ago." },
  until: { type: "string", description: "YYYY-MM-DD inclusive. Default: today." },
};

const TOOLS = [
  { name: "list_stores", description: "Stores this connector can read, and whether each is installed.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  {
    name: "get_sales_summary",
    description: "Orders and sales for a period: order count, gross sales, discounts, net sales, average order value, share of orders over a threshold (e.g. QAR 450 free delivery), sales by day and by channel/UTM source. Excludes cancelled and test orders. Shopify only returns the last 60 days of orders to this app.",
    inputSchema: { type: "object", properties: { ...STORE_PROP, ...DATE_PROPS, threshold: { type: "number", description: "Order subtotal threshold to count, e.g. 450." } }, required: ["store"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_product_sales",
    description: "Units and revenue per product and variant for a period, best sellers first.",
    inputSchema: { type: "object", properties: { ...STORE_PROP, ...DATE_PROPS, limit: { type: "integer", description: "Max rows, default 50." } }, required: ["store"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_products",
    description: "Products with status, variants, prices and stock on hand.",
    inputSchema: { type: "object", properties: { ...STORE_PROP, search: { type: "string", description: "Optional Shopify product search, e.g. 'title:*goat*' or 'status:active'." }, limit: { type: "integer", description: "Default 100, max 250." } }, required: ["store"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "run_shopifyql",
    description: "Run a read-only ShopifyQL analytics query (the language behind Shopify's Analytics reports), e.g. \"FROM sales SHOW total_sales, orders GROUP BY day SINCE -30d\". Returns the table.",
    inputSchema: { type: "object", properties: { ...STORE_PROP, query: { type: "string" } }, required: ["store", "query"] },
    annotations: { readOnlyHint: true },
  },
];

function dateRange(a) {
  const day = 86400000;
  const until = a.until && /^\d{4}-\d{2}-\d{2}$/.test(a.until) ? a.until : new Date().toISOString().slice(0, 10);
  const since = a.since && /^\d{4}-\d{2}-\d{2}$/.test(a.since) ? a.since : new Date(Date.parse(until) - 29 * day).toISOString().slice(0, 10);
  return { since, until };
}

const ORDERS_Q = `query($q:String!,$after:String){ orders(first:100, after:$after, query:$q, sortKey:CREATED_AT){
  pageInfo{ hasNextPage endCursor }
  nodes{ name createdAt test cancelledAt sourceName
    customerJourneySummary{ lastVisit{ source utmParameters{ source medium campaign content } } }
    subtotalPriceSet{ shopMoney{ amount currencyCode } }
    totalPriceSet{ shopMoney{ amount currencyCode } }
    totalDiscountsSet{ shopMoney{ amount } }
    lineItems(first:50){ nodes{ name sku quantity product{ id title } variant{ id title } originalTotalSet{ shopMoney{ amount } } discountedTotalSet{ shopMoney{ amount } } } }
  } } }`;

async function fetchOrders(st, since, until, max = 2500) {
  const q = `created_at:>=${since} created_at:<=${until}T23:59:59 -status:cancelled -test:true`;
  const out = [];
  let after = null;
  while (out.length < max) {
    const d = await gql(st, ORDERS_Q, { q, after });
    out.push(...d.orders.nodes.filter(o => !o.test && !o.cancelledAt));
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return { orders: out, truncated: out.length >= max };
}

const money = x => Number((x && x.shopMoney && x.shopMoney.amount) || 0);
const r2 = n => Math.round(n * 100) / 100;

async function callTool(name, a = {}) {
  if (name === "list_stores") {
    return { stores: storeKeys().map(k => { const s = store(k); return { store: s.key, label: s.label, shop: s.shop, installed: !!s.token }; }) };
  }
  const st = store(a.store);
  if (name === "get_sales_summary") {
    const { since, until } = dateRange(a);
    const { orders, truncated } = await fetchOrders(st, since, until);
    let gross = 0, disc = 0, total = 0, over = 0;
    const byDay = {}, bySource = {};
    for (const o of orders) {
      const sub = money(o.subtotalPriceSet), t = money(o.totalPriceSet), d = money(o.totalDiscountsSet);
      gross += sub + d; disc += d; total += t;
      if (a.threshold && sub >= a.threshold) over++;
      const day = o.createdAt.slice(0, 10);
      byDay[day] = byDay[day] || { orders: 0, sales: 0 }; byDay[day].orders++; byDay[day].sales += t;
      const v = o.customerJourneySummary && o.customerJourneySummary.lastVisit;
      const src = (v && v.utmParameters && v.utmParameters.source) || (v && v.source) || o.sourceName || "unknown";
      bySource[src] = bySource[src] || { orders: 0, sales: 0 }; bySource[src].orders++; bySource[src].sales += t;
    }
    const cur = orders[0] && orders[0].totalPriceSet.shopMoney.currencyCode;
    return {
      store: st.label, since, until, currency: cur, orders: orders.length, truncated,
      gross_sales: r2(gross), discounts: r2(disc), total_sales: r2(total),
      average_order_value: orders.length ? r2(total / orders.length) : 0,
      ...(a.threshold ? { threshold: a.threshold, orders_at_or_over_threshold: over, share_over_threshold_pct: orders.length ? r2(100 * over / orders.length) : 0 } : {}),
      by_day: Object.entries(byDay).sort().map(([day, v]) => ({ day, orders: v.orders, sales: r2(v.sales) })),
      by_source: Object.entries(bySource).map(([source, v]) => ({ source, orders: v.orders, sales: r2(v.sales) })).sort((x, y) => y.sales - x.sales),
    };
  }
  if (name === "get_product_sales") {
    const { since, until } = dateRange(a);
    const { orders, truncated } = await fetchOrders(st, since, until);
    const rows = {};
    for (const o of orders) for (const li of o.lineItems.nodes) {
      const id = (li.variant && li.variant.id) || li.name;
      rows[id] = rows[id] || { product: li.product ? li.product.title : li.name, variant: li.variant ? li.variant.title : "", sku: li.sku, units: 0, revenue: 0, orders: 0 };
      rows[id].units += li.quantity; rows[id].revenue += money(li.discountedTotalSet); rows[id].orders++;
    }
    const limit = Math.min(Math.max(parseInt(a.limit || 50, 10), 1), 500);
    return { store: st.label, since, until, orders: orders.length, truncated, products: Object.values(rows).map(x => ({ ...x, revenue: r2(x.revenue) })).sort((x, y) => y.revenue - x.revenue).slice(0, limit) };
  }
  if (name === "list_products") {
    const limit = Math.min(Math.max(parseInt(a.limit || 100, 10), 1), 250);
    const d = await gql(st, `query($q:String,$n:Int!){ products(first:$n, query:$q){ nodes{ id title status productType vendor totalInventory
      variants(first:20){ nodes{ title sku price inventoryQuantity } } } } }`, { q: a.search || null, n: limit });
    return { store: st.label, products: d.products.nodes };
  }
  if (name === "run_shopifyql") {
    const query = String(a.query || "");
    if (!/^\s*FROM\s/i.test(query)) throw new Error("ShopifyQL queries start with FROM.");
    const d = await gql(st, `query($q:String!){ shopifyqlQuery(query:$q){ tableData{ columns{ name dataType displayName } rows } parseErrors } }`, { q: query });
    return { store: st.label, result: d.shopifyqlQuery };
  }
  throw new Error(`Unknown tool: ${name}`);
}

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMessage(m) {
  const { id, method, params } = m || {};
  if (id === undefined || id === null) return null;
  if (method === "initialize") {
    const v = params && params.protocolVersion;
    return ok(id, { protocolVersion: PROTOCOL_VERSIONS.includes(v) ? v : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
      instructions: "Read-only Shopify data for Blusteak's client stores. Call list_stores first, then pass store to the other tools." });
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "resources/list") return ok(id, { resources: [] });
  if (method === "prompts/list") return ok(id, { prompts: [] });
  if (method === "tools/call") {
    try {
      const out = await callTool(params && params.name, (params && params.arguments) || {});
      return ok(id, { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false });
    } catch (e) { return ok(id, { content: [{ type: "text", text: String(e.message || e) }], isError: true }); }
  }
  return err(id, -32601, `Method not found: ${method}`);
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

module.exports = async function handler(req, res) {
  const expected = process.env.MCP_PATH_KEY;
  if (!expected || !safeEqual((req.query && req.query.key) || "", expected)) { res.statusCode = 404; return res.end("Not found"); }
  if (req.method === "DELETE") { res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; res.setHeader("Allow", "POST"); return res.end(); }
  let body;
  try { body = await readBody(req); } catch { res.statusCode = 400; return res.end(JSON.stringify(err(null, -32700, "Parse error"))); }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(handleMessage))).filter(Boolean);
  if (!replies.length) { res.statusCode = 202; return res.end(); }
  res.statusCode = 200; res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(batch ? replies : replies[0]));
};
module.exports._internal = { handleMessage, callTool };
