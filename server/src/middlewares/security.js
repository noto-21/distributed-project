// Browser-facing protections: CORS for the React app, security headers, and per-IP rate limits on auth.
const cors = require("cors");
const env = require("../config/env");
const AppError = require("../utils/AppError");

// Only the React app may call the API from a browser. Tokens travel in the Authorization header,
// never cookies, so credentials stay off.
const corsPolicy = cors({
  origin: env.corsOrigins,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600,
});

// A JSON-only API never needs to load scripts, frames or styles, so the strictest policy fits.
function securityHeaders(req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-site",
  });
  if (env.nodeEnv === "production") res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

// Fixed-window limiter keyed by client IP (req.ip honours NGINX's X-Forwarded-For via `trust proxy`).
// shortcut: counters live in this replica's memory, so with 2 replicas per branch a client can get up to
// 2x `max` per branch; move them to a shared store (Mongo TTL collection / Redis) if that matters.
function rateLimit({ name, max, windowMs = 15 * 60 * 1000 }) {
  const hits = new Map(); // key -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${req.ip}`;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    res.set("RateLimit-Limit", String(max));
    res.set("RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return next(new AppError("Too many attempts, try again later", 429, "RATE_LIMITED"));
    }
    next();
  };
}

module.exports = { corsPolicy, securityHeaders, rateLimit };
