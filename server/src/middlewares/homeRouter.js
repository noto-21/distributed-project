// Every signed-in request runs at the user's HOME branch. The client calls one URL (/api/...) and NGINX may
// pick any branch; if that isn't the user's home, this forwards the request there over the internal network
// and relays the answer unchanged. One hop at most: the home branch always handles it itself.
const env = require("../config/env");
const lamportClock = require("../utils/lamportClock");
const discoveryService = require("../services/discoveryService");
const AppError = require("../utils/AppError");

const NAMES = { ajax: "Ajax", oshawa: "Oshawa", whitby: "Whitby" };
const offline = (home) => AppError.serviceUnavailable(`Your branch (${NAMES[home] || home}) is temporarily unavailable, please try again shortly`, "HOME_BRANCH_OFFLINE");

async function routeToHome(req, res, next) {
  const home = req.user?.homeBranch;
  if (!home || home === env.branchId) return next();

  let baseUrl;
  try {
    baseUrl = discoveryService.getPeerUrl(home);
  } catch {
    return next(offline(home)); // unknown or marked offline by the heartbeats
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.forwardTimeoutMs);
  try {
    const upstream = await fetch(`${baseUrl}${req.originalUrl}`, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: req.headers.authorization, // the home branch verifies the same token itself
        "X-Forwarded-For": req.ip,
        "x-forwarded-by-branch": env.branchId,
        "x-lamport-timestamp": String(lamportClock.tick()),
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
      signal: controller.signal,
    });
    lamportClock.sync(upstream.headers.get("x-lamport-timestamp") ?? undefined);
    res.status(upstream.status);
    res.set("Content-Type", upstream.headers.get("content-type") || "application/json");
    res.set("x-served-by-branch", home);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    next(offline(home));
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { routeToHome, NAMES };
