const errorHandler = (err, req, res, next) => {
  console.error("[Error]", {
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userId: req.userId,
  });

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
