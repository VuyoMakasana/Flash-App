const { validationResult } = require("express-validator");

const validate = (validations) => {
  return async (req, res, next) => {
    await Promise.all(validations.map((validation) => validation.run(req)));

    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }

    res.status(400).json({
      errors: errors.array().map((err) => ({
        field: err.param,
        message: err.msg,
      })),
    });
  };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Route params that end in "Id" but are backed by a free-text VARCHAR
// column rather than a UUID primary key (e.g. sizingRoutes' :storeId) —
// skip UUID validation for these so legitimate values aren't rejected.
const NON_UUID_ID_PARAMS = new Set(["storeId"]);

// Validates every :xxxId / :id route param present on the request, not a
// fixed list — previously this only checked req.params.id/userId/driverId/
// orderId, so mounting it on a route with e.g. :requestId, :postId,
// :productId, :returnId, or :cardId silently validated nothing at all.
const validateId = (req, res, next) => {
  for (const [key, value] of Object.entries(req.params)) {
    const isIdParam = key === "id" || /Id$/.test(key);
    if (!isIdParam || NON_UUID_ID_PARAMS.has(key)) continue;
    if (value && !UUID_RE.test(value)) {
      return res.status(400).json({ error: `Invalid ${key} format` });
    }
  }
  next();
};

const validatePagination = (req, res, next) => {
  const page = parseInt(req.query.page);
  const limit = parseInt(req.query.limit);

  if (req.query.page && (isNaN(page) || page < 1)) {
    return res.status(400).json({ error: "Page must be a positive integer" });
  }
  if (req.query.limit && (isNaN(limit) || limit < 1 || limit > 100)) {
    return res.status(400).json({ error: "Limit must be between 1 and 100" });
  }

  next();
};

module.exports = { validate, validateId, validatePagination };
