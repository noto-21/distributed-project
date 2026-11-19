// server.js — Express app + process boot, DB init, graceful shutdown.
const os = require("os");
const express = require("express");
const mongoose = require("mongoose");
const env = require("./config/env"); // validates BRANCH_ID, PORT, MONGO_URI, PEER_URLS
const discoveryService = require("./services/discoveryService");

// ---- Express app (routes/middleware go here) ----
const app = express();
app.use(express.json());

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

// JSON errors. AppErrors carry their own status/code; anything else is a 500 that never leaks its message.
app.use((err, req, res, next) => {
  if (!err.isOperational) console.error(err);
  res.status(err.isOperational ? err.statusCode : 500).json(err.isOperational
    ? { error: err.message, code: err.errorCode }
    : { error: "Internal server error", code: "INTERNAL_ERROR" });
});

// ---- Process boot ----
async function start() {
  await mongoose.connect(env.mongoUri); // this branch's cluster only
  console.log(`[${env.branchId}] connected to MongoDB`);
  discoveryService.start(); // heartbeats mark dead peers unhealthy so searches skip them

  const server = app.listen(env.port, () =>
    console.log(`[${env.branchId}] listening on ${env.port}`),
  );

  const shutdown = (signal) => {
    console.log(`[${env.branchId}] ${signal} received, shutting down`);
    discoveryService.stop();
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
