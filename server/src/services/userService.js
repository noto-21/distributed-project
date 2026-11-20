// A user lives only in their home branch's DB. These helpers create/verify users at THIS branch,
// and check the other branches so one email can't end up with accounts at two branches.
const bcrypt = require("bcryptjs");
const env = require("../config/env");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const { callAllPeers } = require("./peerClient");

// shortcut: a peer that is down can't answer, so a duplicate is still possible while it's offline; a startup
// reconciliation would close that gap if it matters.
async function emailTakenElsewhere(email) {
  const answers = await callAllPeers("GET", `/users/exists?email=${encodeURIComponent(email)}`);
  return answers.find((a) => a.status === 200 && a.body.exists)?.branch ?? null;
}

async function createHere({ email, name, passwordHash, googleId }) {
  const normalized = email.toLowerCase().trim();
  if (await User.exists({ email: normalized })) throw AppError.conflict("Email already registered", "EMAIL_TAKEN");
  if (await emailTakenElsewhere(normalized)) throw AppError.conflict("Email already registered", "EMAIL_TAKEN");
  try {
    // Role is never taken from the client; librarians are promoted in the DB.
    return await User.create({ email: normalized, name, passwordHash, googleId, homeBranch: env.branchId });
  } catch (err) {
    if (err.code === 11000) throw AppError.conflict("Email already registered", "EMAIL_TAKEN");
    throw err;
  }
}

// { exists, user }: user only when the password matches. Google-only accounts never match a password.
async function verifyHere(email, password) {
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) return { exists: false, user: null };
  const ok = Boolean(user.passwordHash) && (await bcrypt.compare(password, user.passwordHash));
  return { exists: true, user: ok ? user : null };
}

module.exports = { emailTakenElsewhere, createHere, verifyHere };
