// A user lives only in their home branch's DB. These helpers create/verify users at THIS branch,
// and check the other branches so one email can't end up with accounts at two branches.
const bcrypt = require("bcryptjs");
const env = require("../config/env");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const lamportClock = require("../utils/lamportClock");
const { callAllPeers } = require("./peerClient");

const ACTIVE = { duplicateOf: null }; // accounts that lost a duplicate-email reconciliation are ignored

// A peer that is down can't answer, so a duplicate can still slip in while it's offline;
// reconcileDuplicates() repairs that once the branches can see each other again.
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
    return await User.create({
      email: normalized, name, passwordHash, googleId, homeBranch: env.branchId, createdLamport: lamportClock.tick(),
    });
  } catch (err) {
    if (err.code === 11000) throw AppError.conflict("Email already registered", "EMAIL_TAKEN");
    throw err;
  }
}

// { exists, user }: user only when the password matches. Google-only accounts never match a password.
async function verifyHere(email, password) {
  const user = await User.findOne({ email: email.toLowerCase().trim(), ...ACTIVE });
  if (!user) return { exists: false, user: null };
  const ok = Boolean(user.passwordHash) && (await bcrypt.compare(password, user.passwordHash));
  return { exists: true, user: ok ? user : null };
}

// For peers: which of these emails have an active account here, and when were they created (Lamport).
async function activeByEmail(emails) {
  return User.find({ email: { $in: emails }, ...ACTIVE }, { email: 1, createdLamport: 1, _id: 0 }).lean();
}

// Deterministic total order on account creation, identical on every branch: Lamport time, then branch name.
const createdFirst = (a, b) => (a.lamport !== b.lamport ? a.lamport < b.lamport : a.branch < b.branch);

// The same email registered at two branches (one was offline at signup). Every branch runs this for its own
// users; all compute the same winner (earliest by createdFirst), and only the loser flags its own account.
// shortcut: sends every local email in one request; page it if a branch ever holds many thousands of users.
async function reconcileDuplicates() {
  const mine = await User.find(ACTIVE, { email: 1, createdLamport: 1 }).lean();
  if (!mine.length) return { flagged: [] };
  const answers = await callAllPeers("POST", "/users/lookup", { emails: mine.map((u) => u.email) });

  const flagged = [];
  for (const user of mine) {
    const me = { lamport: user.createdLamport || 0, branch: env.branchId };
    const earlier = answers
      .flatMap((a) => (a.status === 200 ? a.body.users.filter((u) => u.email === user.email).map((u) => ({ lamport: u.createdLamport || 0, branch: a.branch })) : []))
      .find((other) => createdFirst(other, me));
    if (earlier) {
      await User.updateOne({ _id: user._id, ...ACTIVE }, { $set: { duplicateOf: earlier.branch } });
      flagged.push({ email: user.email, keptAt: earlier.branch });
    }
  }
  return { flagged };
}

module.exports = { emailTakenElsewhere, createHere, verifyHere, activeByEmail, reconcileDuplicates, ACTIVE };
