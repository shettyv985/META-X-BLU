// One-store Shopify read-only MCP server.
// Endpoint: https://<project>.vercel.app/api/shopify/mcp/<store>/<MCP_PATH_KEY>
//   e.g. /api/shopify/mcp/halwa/<key> can only read SHOPIFY_HALWA_* — no other store.
// The all-stores endpoint (/api/shopify/mcp/<key>) is unchanged.
const { serve } = require("../[key].js");

module.exports = function handler(req, res) {
  return serve(req, res, req.query && req.query.store);
};
