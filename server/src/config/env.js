// Loads and validates this branch's config. Fails fast at boot so a misconfigured branch never starts.
const path = require("path");

// Root .env for local runs. In Docker the file isn't there and compose supplies the vars instead.
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

const VALID_BRANCHES = ["ajax", "oshawa", "whitby"];

// "ajax=http://branch-ajax:3000,whitby=http://branch-whitby:3000" -> { ajax: '...', whitby: '...' }
function parsePeerUrls(raw = "", selfId) {
  const peers = {};
  for (const entry of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [branch, url] = entry.split("=").map((s) => s && s.trim());
    if (!VALID_BRANCHES.includes(branch) || !url) {
      throw new Error(
        `Invalid PEER_URLS entry "${entry}". Expected <branch>=<url>, branch one of: ${VALID_BRANCHES.join(", ")}`,
      );
    }
    if (branch !== selfId) peers[branch] = url;
  }
  return peers;
}

function loadEnv(env = process.env) {
  const branchId = (env.BRANCH_ID || "").toLowerCase();
  if (!VALID_BRANCHES.includes(branchId)) {
    throw new Error(
      `Invalid or missing BRANCH_ID "${env.BRANCH_ID}". Must be one of: ${VALID_BRANCHES.join(", ")}`,
    );
  }

  // Compose sets MONGO_URI; locally the root .env holds one URI per branch.
  const mongoUri = env.MONGO_URI || env[`MONGO_URI_${branchId.toUpperCase()}`];
  if (!mongoUri)
    throw new Error(
      `Missing MONGO_URI (or MONGO_URI_${branchId.toUpperCase()}) for branch "${branchId}"`,
    );

  const nodeEnv = env.NODE_ENV || "development";
  if (nodeEnv === "production" && !env.JWT_SECRET)
    throw new Error("JWT_SECRET is required in production");

  return {
    nodeEnv,
    branchId,
    validBranches: VALID_BRANCHES,
    port: Number(env.PORT) || 3000,
    mongoUri,
    peers: parsePeerUrls(env.PEER_URLS, branchId),
    jwtSecret: env.JWT_SECRET || "dev-secret-change-in-prod",
    jwtExpiresIn: env.JWT_EXPIRES_IN || "15m", // short: refresh tokens (refreshDays) keep users signed in
    refreshDays: Number(env.REFRESH_TOKEN_DAYS) || 7,
    clientUrl: env.CLIENT_URL || "http://localhost:5173",
    // Browser origins allowed to call the API (comma-separated). Defaults to the React dev server.
    corsOrigins: (env.CORS_ORIGINS || env.CLIENT_URL || "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
    authRateLimit: Number(env.AUTH_RATE_LIMIT) || 10, // attempts per IP per 15 min on login/register/refresh
    holdDays: Number(env.HOLD_DAYS) || 3, // a requested copy waits this long for its requester
    loanDays: Number(env.LOAN_DAYS) || 14,
    // Optional: Google login returns 501 unless both are set.
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            redirectUri:
              env.GOOGLE_REDIRECT_URI ||
              `http://localhost:8090/${branchId}/api/auth/google/callback`,
          }
        : null,
    peerTimeoutMs: Number(env.PEER_TIMEOUT_MS) || 3000,
    discoveryIntervalMs: Number(env.DISCOVERY_INTERVAL_MS) || 5000,

    internalSecret: env.INTERNAL_API_SECRET || "dev-internal-secret-change-in-prod",
  };
}

module.exports = loadEnv();
module.exports.loadEnv = loadEnv;
module.exports.parsePeerUrls = parsePeerUrls;
