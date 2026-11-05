// Step 2 of the one-time install. Shopify returns here after "Install".
// Checks Shopify's signature, swaps the code for an offline access token and shows it ONCE
// so you can paste it into Vercel as SHOPIFY_<KEY>_TOKEN. The token is not stored or logged.
const { store, checkState, checkShopifyHmac } = require("../../lib/shopify");

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#162568}
code{display:block;word-break:break-all;background:#f3f4f8;padding:12px;border-radius:8px;font-size:14px}
.warn{color:#8a1c1c}</style></head><body><h2>${title}</h2>${body}</body></html>`;
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const key = String(q.state || "").split(".")[0];
  let st;
  try { st = store(key); } catch { res.statusCode = 400; return res.end(page("Install failed", "<p>Unknown store.</p>")); }
  const shop = String(q.shop || "");
  if (shop !== st.shop) { res.statusCode = 400; return res.end(page("Install failed", "<p>Store does not match.</p>")); }
  if (!checkState(q.state, st.clientSecret) || !checkShopifyHmac(q, st.clientSecret)) {
    res.statusCode = 400; return res.end(page("Install failed", "<p>Security check failed or the link expired. Start again from the install link.</p>"));
  }
  const r = await fetch(`https://${st.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: st.clientId, client_secret: st.clientSecret, code: q.code }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) {
    res.statusCode = 502;
    return res.end(page("Install failed", `<p>Shopify did not return a token (${r.status}). Try again.</p>`));
  }
  const varName = `SHOPIFY_${st.key.toUpperCase()}_TOKEN`;
  res.statusCode = 200;
  res.end(page(`${st.label}: installed`, `
<p>Granted scopes: <b>${String(body.scope || "").replace(/</g, "")}</b></p>
<p>Copy this token into Vercel → blu-x-data → Settings → Environment Variables as <b>${varName}</b>, then redeploy.</p>
<code>${body.access_token}</code>
<p class="warn">This page shows the token only once and nothing is saved. Do not paste it in chat, email or Slack. Close this tab when done.</p>`));
};
