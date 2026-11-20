// Refresh tokens: long-lived, opaque, stored (hashed) at the user's HOME branch, rotated on every use.
// Format "<homeBranch>.<random>": any branch can tell where a token lives and forward refresh/logout there.
// Access tokens (JWT, 15 min) stay stateless; logout stops new ones being minted, and the last one expires soon.
const crypto = require("crypto");
const env = require("../config/env");
const User = require("../models/User");
const RefreshToken = require("../models/RefreshToken");
const AppError = require("../utils/AppError");
const { signToken } = require("../middlewares/auth");
const { callPeer } = require("./peerClient");

const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const invalid = () => AppError.unauthorized("Invalid or expired refresh token", "INVALID_REFRESH_TOKEN");

function branchOf(token) {
  const branch = typeof token === "string" ? token.split(".")[0] : "";
  if (!env.validBranches.includes(branch)) throw invalid();
  return branch;
}

// Mint a refresh token for a user whose home is THIS branch.
async function issueRefresh(userId) {
  const token = `${env.branchId}.${crypto.randomBytes(32).toString("base64url")}`;
  await RefreshToken.create({
    tokenHash: hash(token),
    userId: String(userId),
    expiresAt: new Date(Date.now() + env.refreshDays * 86_400_000),
  });
  return token;
}

// Full login response for a user whose home is THIS branch.
async function sessionFor(user) {
  return { token: signToken(user), refreshToken: await issueRefresh(user._id), user, homeBranch: user.homeBranch };
}

async function refreshHere(token) {
  const tokenHash = hash(token);
  // Atomic claim: of two concurrent uses of one token, only one gets to rotate it.
  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { revokedAt: new Date() } },
  );
  if (!claimed) {
    // A token that exists but was already used means it was copied: end every session of that user.
    const reused = await RefreshToken.findOne({ tokenHash });
    if (reused?.revokedAt) {
      await RefreshToken.updateMany({ userId: reused.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
      throw AppError.unauthorized("Refresh token already used; all sessions were signed out", "REFRESH_TOKEN_REUSED");
    }
    throw invalid();
  }
  const user = await User.findById(claimed.userId);
  if (!user || user.duplicateOf) throw invalid();
  const session = await sessionFor(user);
  await RefreshToken.updateOne({ _id: claimed._id }, { $set: { replacedBy: hash(session.refreshToken) } });
  return session;
}

async function logoutHere(token) {
  await RefreshToken.updateOne({ tokenHash: hash(token), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

// Public entry points: work at any branch, forwarding to the token's home branch.
async function refresh(token) {
  const branch = branchOf(token);
  if (branch === env.branchId) return refreshHere(token);
  const { status, body } = await callPeer(branch, "POST", "/auth/refresh", { refreshToken: token });
  if (status !== 200) throw new AppError(body.error || "Refresh failed", status, body.code || "INVALID_REFRESH_TOKEN");
  return body;
}

async function logout(token) {
  const branch = branchOf(token);
  if (branch === env.branchId) return logoutHere(token);
  await callPeer(branch, "POST", "/auth/logout", { refreshToken: token });
}

module.exports = { issueRefresh, sessionFor, refresh, refreshHere, logout, logoutHere, hash };
