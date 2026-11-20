// server.js — Express app + process boot, DB init, graceful shutdown.
const os = require("os");
const express = require("express");
const mongoose = require("mongoose");
const env = require("./config/env"); // validates BRANCH_ID, PORT, MONGO_URI, PEER_URLS
const discoveryService = require("./services/discoveryService");
const maintenance = require("./services/maintenance");
const { corsPolicy, securityHeaders } = require("./middlewares/security");

// ---- Express app (routes/middleware go here) ----
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // one hop: NGINX. req.ip is then the real client for rate limiting
app.use(securityHeaders);
app.use(corsPolicy);
app.use(express.json({ limit: "100kb" }));

// Readiness: 200 only when this branch's DB connection is up. instance = container hostname (which replica answered).
app.get("/healthz", (req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res
    .status(ready ? 200 : 503)
    .json({
      status: ready ? "ok" : "db-unavailable",
      branchId: env.branchId,
      instance: os.hostname(),
    });
});

// Public API routes (accessible via /<branch>/api/... through NGINX)
app.use("/api/auth", require("./routes/auth"));
app.use("/api/circulation", require("./routes/circulationRoutes"));

// Peer-only internal routes (blocked at NGINX, protected by INTERNAL_API_SECRET)
app.use("/internal", require("./routes/internalRoutes"));

// JSON errors. AppErrors carry their own status/code; client errors from Express itself (malformed JSON,
// oversized body) are 4xx with expose=true; anything else is a 500 that never leaks its message.
app.use((err, req, res, next) => {
  if (err.isOperational) {
    return res.status(err.statusCode).json({ error: err.message, code: err.errorCode, ...(err.details && { details: err.details }) });
  }
  if (err.expose && err.status >= 400 && err.status < 500) {
    const code = err.type === "entity.parse.failed" ? "INVALID_JSON" : "BAD_REQUEST";
    return res.status(err.status).json({ error: code === "INVALID_JSON" ? "Request body is not valid JSON" : err.message, code });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error", code: "INTERNAL_ERROR" });
});

// ---- Process boot ----
// Retry instead of crashing: under nodemon a crash is never restarted, so a brief Atlas outage at boot
// would leave the branch dead. /healthz answers 503 meanwhile, so Docker/NGINX still see it as not ready.
async function connectWithRetry({ connect = () => mongoose.connect(env.mongoUri), delayMs = 5000, log = console.error } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await connect();
    } catch (err) {
      log(`[${env.branchId}] MongoDB connect failed (attempt ${attempt}): ${err.message}. Retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function start() {
  const server = app.listen(env.port, () =>
    console.log(`[${env.branchId}] listening on ${env.port}`),
  );

  await connectWithRetry(); // this branch's cluster only
  console.log(`[${env.branchId}] connected to MongoDB`);
  discoveryService.start(); // heartbeats mark dead peers unhealthy so searches skip them
  maintenance.start(); // saga crash recovery, expired holds, duplicate-email repair

  const shutdown = (signal) => {
    console.log(`[${env.branchId}] ${signal} received, shutting down`);
    discoveryService.stop();
    maintenance.stop();
    server.close(async () => {
      // stop accepting, let in-flight requests finish
      await mongoose.connection.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref(); // force-exit if something hangs
  };
  process.on("SIGTERM", () => shutdown("SIGTERM")); // docker stop / k8s
  process.on("SIGINT", () => shutdown("SIGINT")); // Ctrl+C
}

// Only boot when run directly (node src/server.js). Tests can require('../src/server') and get the app without listening.
if (require.main === module) {
  start().catch((err) => {
    console.error("Startup failed:", err);
    process.exit(1); // a crash makes Docker restart it or mark it unhealthy
  });
}

module.exports = app;
module.exports.connectWithRetry = connectWithRetry;
