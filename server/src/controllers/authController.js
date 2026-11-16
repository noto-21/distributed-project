const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const User = require('../models/User');
const { signToken } = require('../middlewares/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_COOKIE = 'oauth_state';

const authResponse = (user) => ({ token: signToken(user), user });

async function register(req, res) {
  const { email, password, name } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email required' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    // Role is never taken from the client; librarians are promoted in the DB.
    const user = await User.create({
      email, name, passwordHash: await bcrypt.hash(password, 10), homeBranch: env.branchId,
    });
    res.status(201).json(authResponse(user));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Email already registered' });
    throw err;
  }
}

async function login(req, res) {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Email and password required' });

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  // Same message for unknown email, Google-only account and wrong password.
  if (!user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json(authResponse(user));
}

async function me(req, res) {
  const user = await User.findById(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
}

// ---- Google OAuth 2.0 (authorization code flow) ----
// State lives in a cookie, not server memory, so start and callback may hit different replicas.

function googleStart(req, res) {
  if (!env.google) return res.status(501).json({ error: 'Google OAuth not configured' });
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true, sameSite: 'lax', secure: env.nodeEnv === 'production', maxAge: 10 * 60 * 1000, path: '/',
  });
  const params = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: env.google.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

const readCookie = (req, name) =>
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];

async function googleCallback(req, res) {
  if (!env.google) return res.status(501).json({ error: 'Google OAuth not configured' });
  const { code, state, error } = req.query;
  const expected = readCookie(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, { path: '/' });

  if (error) return res.redirect(`${env.clientUrl}/auth/callback#error=${encodeURIComponent(error)}`);
  if (typeof code !== 'string' || !state || state !== expected) return res.status(400).json({ error: 'Invalid OAuth state' });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      redirect_uri: env.google.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return res.status(502).json({ error: 'Google token exchange failed' });
  const { access_token: accessToken } = await tokenRes.json();

  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!infoRes.ok) return res.status(502).json({ error: 'Google userinfo failed' });
  const profile = await infoRes.json();
  if (!profile.email_verified) return res.status(403).json({ error: 'Google email not verified' });

  // Existing Google user -> existing local account with same email (link it) -> new account at this branch.
  let user = await User.findOne({ googleId: profile.sub })
    || await User.findOne({ email: profile.email.toLowerCase() });
  if (user && !user.googleId) {
    user.googleId = profile.sub;
    await user.save();
  }
  if (!user) {
    user = await User.create({
      email: profile.email, name: profile.name, googleId: profile.sub, homeBranch: env.branchId,
    });
  }

  // Fragment, not query string: never sent to servers or logged by NGINX.
  res.redirect(`${env.clientUrl}/auth/callback#token=${signToken(user)}`);
}

module.exports = { register, login, me, googleStart, googleCallback };
