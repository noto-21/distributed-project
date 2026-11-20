const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const env = require("../config/env");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const { signToken } = require("../middlewares/auth");
const { callPeer, callAllPeers } = require("../services/peerClient");
const userService = require("../services/userService");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_COOKIE = "oauth_state";

// homeBranch in the response tells the client which /<branch>/ prefix to use from now on.
const authResponse = (user) => ({ token: signToken(user), user, homeBranch: user.homeBranch });

// POST /api/auth/register { email, password, name, homeBranch }
// Any branch can take the request; the account is created in the chosen home branch's DB.
async function register(req, res, next) {
  try {
    const { email, password, name, homeBranch } = req.body || {};
    if (typeof email !== "string" || !EMAIL_RE.test(email)) throw AppError.badRequest("Valid email required");
    if (typeof password !== "string" || password.length < 8) throw AppError.badRequest("Password must be at least 8 characters");
    if (!env.validBranches.includes(homeBranch)) {
      throw AppError.badRequest(`homeBranch must be one of: ${env.validBranches.join(", ")}`, "INVALID_HOME_BRANCH");
    }

    // Hash here so only the hash ever crosses to another branch.
    const passwordHash = await bcrypt.hash(password, 10);
    if (homeBranch === env.branchId) {
      const user = await userService.createHere({ email, name, passwordHash });
      return res.status(201).json(authResponse(user));
    }

    const { status, body } = await callPeer(homeBranch, "POST", "/users", { email, name, passwordHash });
    if (status !== 201) return res.status(status).json(body);
    res.status(201).json(authResponse(body.user));
  } catch (err) {
    if (err.errorCode === "PEER_OFFLINE" || err.errorCode === "PEER_UNAVAILABLE") {
      return next(AppError.serviceUnavailable(`Home branch '${req.body.homeBranch}' is offline, try again shortly`, "HOME_BRANCH_OFFLINE"));
    }
    next(err);
  }
}

// POST /api/auth/login { email, password } at any branch. If the user isn't here, the branches that are
// reachable are asked; whichever holds the account verifies the password.
async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string") throw AppError.badRequest("Email and password required");

    const local = await userService.verifyHere(email, password);
    let user = local.user;
    if (!local.exists) {
      // Plain password goes to peers only over the internal network, guarded by INTERNAL_API_SECRET.
      const answers = await callAllPeers("POST", "/users/verify", { email, password });
      user = answers.find((a) => a.status === 200)?.body.user ?? null;
    }
    // Same message for unknown email, Google-only account and wrong password.
    if (!user) return res.status(401).json({ error: "Invalid email or password", code: "INVALID_CREDENTIALS" });
    res.json(authResponse(user));
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const { userId, homeBranch } = req.user;
    if (homeBranch !== env.branchId) {
      const { status, body } = await callPeer(homeBranch, "GET", `/users/${encodeURIComponent(userId)}`);
      return res.status(status).json(body);
    }
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

// ---- Google OAuth 2.0 (authorization code flow) ----
// State lives in a cookie, not server memory, so start and callback may hit different replicas.
// The home branch of a NEW Google user is the branch whose /<branch>/api/auth/google URL started the flow.

function googleStart(req, res) {
  if (!env.google) return res.status(501).json({ error: "Google OAuth not configured" });
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.nodeEnv === "production",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });
  const params = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: env.google.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

const readCookie = (req, name) =>
  (req.headers.cookie || "")
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === name)?.[1];

async function googleCallback(req, res) {
  if (!env.google) return res.status(501).json({ error: "Google OAuth not configured" });
  const { code, state, error } = req.query;
  const expected = readCookie(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, { path: "/" });

  if (error)
    return res.redirect(`${env.clientUrl}/auth/callback#error=${encodeURIComponent(error)}`);
  if (typeof code !== "string" || !state || state !== expected)
    return res.status(400).json({ error: "Invalid OAuth state" });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      redirect_uri: env.google.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return res.status(502).json({ error: "Google token exchange failed" });
  const { access_token: accessToken } = await tokenRes.json();

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!infoRes.ok) return res.status(502).json({ error: "Google userinfo failed" });
  const profile = await infoRes.json();
  if (!profile.email_verified) return res.status(403).json({ error: "Google email not verified" });

  // Existing Google user -> existing local account with same email (link it) -> new account at this branch.
  let user =
    (await User.findOne({ googleId: profile.sub })) ||
    (await User.findOne({ email: profile.email.toLowerCase() }));
  if (user && !user.googleId) {
    user.googleId = profile.sub;
    await user.save();
  }
  if (!user) {
    const elsewhere = await userService.emailTakenElsewhere(profile.email.toLowerCase());
    if (elsewhere) {
      return res.redirect(`${env.clientUrl}/auth/callback#error=account_at_${elsewhere}`);
    }
    user = await User.create({
      email: profile.email,
      name: profile.name,
      googleId: profile.sub,
      homeBranch: env.branchId,
    });
  }

  // Fragment, not query string: never sent to servers or logged by NGINX.
  res.redirect(`${env.clientUrl}/auth/callback#token=${signToken(user)}`);
}

module.exports = { register, login, me, googleStart, googleCallback };
