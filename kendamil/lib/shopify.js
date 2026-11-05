// Shared Shopify helpers (read-only). One Dev Dashboard app per client store.
// Env vars per store, where <KEY> is a short upper-case name such as KENDAMIL:
//   SHOPIFY_<KEY>_SHOP           e.g. v8hm6m-gc.myshopify.com
//   SHOPIFY_<KEY>_CLIENT_ID      from the app's Settings in the Dev Dashboard
//   SHOPIFY_<KEY>_CLIENT_SECRET  from the app's Settings in the Dev Dashboard
//   SHOPIFY_<KEY>_TOKEN          shown once by /api/shopify/callback after install
//   SHOPIFY_<KEY>_LABEL          optional display name, e.g. "Kendamil Qatar"
// Shared:
//   MCP_PATH_KEY                 same secret as the Meta connector
//   SHOPIFY_API_VERSION          optional, default 2026-01
const crypto = require("crypto");

const SCOPES = "read_orders,read_products,read_inventory,read_reports,read_analytics";

function apiVersion() { return process.env.SHOPIFY_API_VERSION || "2026-01"; }

function storeKeys() {
  return Object.keys(process.env)
    .map(k => (k.match(/^SHOPIFY_([A-Z0-9]+)_SHOP$/) || [])[1])
    .filter(Boolean)
    .map(k => k.toLowerCase());
}

function store(key) {
  const k = String(key || "").trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(k)) throw new Error(`Unknown store "${key}". Use list_stores.`);
  const shop = (process.env[`SHOPIFY_${k}_SHOP`] || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!shop) throw new Error(`Unknown store "${key}". Use list_stores.`);
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) throw new Error(`SHOPIFY_${k}_SHOP must look like name.myshopify.com`);
  return {
    key: k.toLowerCase(), shop,
    label: process.env[`SHOPIFY_${k}_LABEL`] || shop,
    clientId: process.env[`SHOPIFY_${k}_CLIENT_ID`] || "",
    clientSecret: process.env[`SHOPIFY_${k}_CLIENT_SECRET`] || "",
    token: process.env[`SHOPIFY_${k}_TOKEN`] || "",
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function signState(storeKey, secret) {
  const payload = `${storeKey}.${Date.now()}.${crypto.randomBytes(8).toString("hex")}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function checkState(state, secret, maxAgeMs = 15 * 60 * 1000) {
  const parts = String(state || "").split(".");
  if (parts.length !== 4) return null;
  const [k, ts, nonce, sig] = parts;
  const good = crypto.createHmac("sha256", secret).update(`${k}.${ts}.${nonce}`).digest("hex");
  if (!safeEqual(sig, good)) return null;
  if (Date.now() - Number(ts) > maxAgeMs) return null;
  return k;
}

// Shopify signs the callback query string with the app's client secret.
function checkShopifyHmac(query, secret) {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const msg = Object.keys(rest).sort().map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`).join("&");
  const good = crypto.createHmac("sha256", secret).update(msg).digest("hex");
  return safeEqual(hmac, good);
}

async function gql(st, query, variables) {
  if (!st.token) throw new Error(`Store ${st.label} is not installed yet (no SHOPIFY_${st.key.toUpperCase()}_TOKEN).`);
  const r = await fetch(`https://${st.shop}/admin/api/${apiVersion()}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": st.token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Shopify ${r.status}: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
  if (body.errors && body.errors.length) throw new Error(`Shopify: ${body.errors.map(e => e.message).join("; ")}`);
  return body.data;
}

module.exports = { SCOPES, apiVersion, storeKeys, store, safeEqual, signState, checkState, checkShopifyHmac, gql };
