const redis = require("redis");

let redisClient = null;

// Initialize Redis client if REDIS_URL is set
if (process.env.REDIS_URL && process.env.REDIS_URL !== "disabled") {
  redisClient = redis.createClient({ url: process.env.REDIS_URL });
  redisClient.connect().catch(console.error);
  redisClient.on("error", (err) => console.warn("[Redis]", err.message));
}

const cache = (duration = 300) => {
  return async (req, res, next) => {
    if (!redisClient || process.env.NODE_ENV === "test") {
      return next();
    }

    // Was never wired up anywhere before now, but its cache key was only
    // req.originalUrl — had this ever been applied to an authenticated,
    // per-user route (e.g. /users/me), two different users hitting the same
    // path would have been served each other's cached response. Segregating
    // by req.userId (present only on authenticated requests, after the
    // `authenticate` middleware runs) makes this safe to use on any route,
    // not just the public ones it's wired onto today.
    const key = `cache:${req.userId ? `user:${req.userId}:` : ""}${req.originalUrl || req.url}`;

    try {
      const cachedData = await redisClient.get(key);
      if (cachedData) {
        return res.json(JSON.parse(cachedData));
      }

      // Store original json method
      const originalJson = res.json;
      res.json = function (data) {
        // Cache successful GET requests
        if (res.statusCode === 200) {
          redisClient.setEx(key, duration, JSON.stringify(data));
        }
        originalJson.call(this, data);
      };

      next();
    } catch (err) {
      console.error("[Cache] Error:", err.message);
      next();
    }
  };
};

const clearCache = async (pattern) => {
  if (!redisClient) return;

  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length) {
      await redisClient.del(keys);
      console.log(`[Cache] Cleared ${keys.length} keys matching: ${pattern}`);
    }
  } catch (err) {
    console.error("[Cache] Clear error:", err.message);
  }
};

module.exports = { cache, clearCache, redisClient };
