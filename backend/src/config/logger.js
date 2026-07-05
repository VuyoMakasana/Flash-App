const pino = require("pino");

// JSON-structured logging with levels and (via pino-http, see server.js)
// a request ID on every log line tied to that request — previously the
// backend only had morgan's plain-text access log plus scattered
// console.log/console.error calls, neither of which are queryable/filterable
// in a real log aggregator.
const defaultLevel =
  process.env.NODE_ENV === "test" ? "silent" :
  process.env.NODE_ENV === "production" ? "info" : "debug";

const logger = pino({
  level: process.env.LOG_LEVEL || defaultLevel,
});

module.exports = logger;
