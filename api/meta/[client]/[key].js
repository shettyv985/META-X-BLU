// Meta Ads read-only MCP server, one connector per client.
// Endpoint: https://<project>.vercel.app/api/meta/<client>/<MCP_PATH_KEY>
//   e.g. /api/meta/halwa/<MCP_PATH_KEY> reads META_HALWA_AD_ACCOUNT_ID.
// All logic lives in lib/meta.js. Read-only: every Meta call is a GET.
const { serve } = require("../../../lib/meta");

module.exports = function handler(req, res) {
  return serve(req, res, req.query && req.query.client);
};
