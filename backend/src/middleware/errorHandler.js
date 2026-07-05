const errorHandler = (err, req, res, next) => {
  // req.log is a pino child logger scoped to this request (via pino-http in
  // server.js) — already carries req.id, so this error line is queryable
  // alongside every other log line for the same request. Falls back to
  // console.error if pino-http isn't in the middleware chain (e.g. a test
  // that constructs the error handler in isolation).
  const log = req.log || console;
  log.error({
    err: { message: err.message, stack: err.stack },
    url: req.url,
    method: req.method,
    ip: req.ip,
    userId: req.userId,
  }, "Unhandled request error");

  // Handle specific error types
  if (err.code === "23505") {
    // PostgreSQL unique violation
    return res.status(409).json({
      error: "Duplicate entry",
      message: "This record already exists",
    });
  }

  if (err.code === "23503") {
    // PostgreSQL foreign key violation
    return res.status(400).json({
      error: "Invalid reference",
      message: "Referenced record does not exist",
    });
  }

  if (err.code === "42P01") {
    // PostgreSQL undefined table
    return res.status(500).json({
      error: "Database error",
      message: "System configuration error",
    });
  }

  if (err.name === "ValidationError") {
    return res.status(400).json({
      error: "Validation error",
      message: err.message,
    });
  }

  if (err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "File too large",
        message: "Maximum file size is 10MB",
      });
    }
    return res.status(400).json({
      error: "Upload error",
      message: err.message,
    });
  }

  // Default error response
  const statusCode = err.statusCode || 500;
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message;

  res.status(statusCode).json({
    error: err.error || "Server error",
    message,
  });
};

// 404 handler
const notFound = (req, res) => {
  res.status(404).json({
    error: "Not found",
    message: `Cannot ${req.method} ${req.url}`,
  });
};

module.exports = { errorHandler, notFound };
