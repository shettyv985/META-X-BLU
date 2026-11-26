const { serve } = require("../../../lib/ga");
module.exports = (req, res) => serve(req, res, req.query && req.query.client);
