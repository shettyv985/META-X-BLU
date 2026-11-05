// Step 1 of the one-time install: /api/shopify/install?store=kendamil&key=<MCP_PATH_KEY>
// Sends you to the store's Shopify admin to approve the read-only app.
// Also used as the app's "App URL": after "Install" on the custom-distribution link, Shopify opens
// /api/shopify/install?shop=...&hmac=...&timestamp=... and we start OAuth for that store.
const { SCOPES, storeKeys, store, safeEqual, signState, checkShopifyHmac } = require("../../lib/shopify");

module.exports = async function handler(req, res) {
  const q = req.query || {};
  let st;
  if (q.shop && q.hmac && !q.key) {
    // Launch from Shopify: find the store by its myshopify domain and verify Shopify's signature.
    const match = storeKeys().map(k => store(k)).find(s => s.shop === String(q.shop));
    if (!match || !match.clientSecret || !checkShopifyHmac(q, match.clientSecret)) { res.statusCode = 404; return res.end("Not found"); }
    if (match.token) { res.statusCode = 200; res.setHeader("Content-Type", "text/plain"); return res.end(`${match.label} is connected. Nothing to do here.`); }
    st = match;
  } else {
    if (!process.env.MCP_PATH_KEY || !safeEqual(q.key || "", process.env.MCP_PATH_KEY)) { res.statusCode = 404; return res.end("Not found"); }
    try { st = store(q.store); } catch (e) { res.statusCode = 400; return res.end(String(e.message)); }
  }
  if (!st.clientId || !st.clientSecret) { res.statusCode = 400; return res.end(`Set SHOPIFY_${st.key.toUpperCase()}_CLIENT_ID and _CLIENT_SECRET in Vercel first.`); }
  const redirect = `https://${req.headers.host}/api/shopify/callback`;
  const url = new URL(`https://${st.shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", st.clientId);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", signState(st.key, st.clientSecret));
  res.statusCode = 302;
  res.setHeader("Location", url.toString());
  res.setHeader("Cache-Control", "no-store");
  res.end();
};
