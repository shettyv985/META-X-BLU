// One-store Shopify read-only MCP server.
// Endpoint: https://<project>.vercel.app/api/shopify/store/<store>/<MCP_PATH_KEY>
//   e.g. /api/shopify/store/halwa/<key> can only read SHOPIFY_HALWA_* — no other store.
// (Not under /api/shopify/mcp/ because Vercel does not allow [key].js and a [store]/ folder side by side.)
// The all-stores endpoint (/api/shopify/mcp/<key>) is unchanged.
const { serve } = require("../../mcp/[key].js");

module.exports = function handler(req, res) {
  return serve(req, res, req.query && req.query.store);
};
