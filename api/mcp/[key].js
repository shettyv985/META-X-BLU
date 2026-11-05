// Original Kendamil Qatar Meta Ads URL, kept so the existing connector keeps working.
// Endpoint: https://<project>.vercel.app/api/mcp/<MCP_PATH_KEY>
// Same as /api/meta/kendamil/<MCP_PATH_KEY>. All logic lives in lib/meta.js.
const { serve } = require("../../lib/meta");

module.exports = function handler(req, res) {
  return serve(req, res, "kendamil");
};
