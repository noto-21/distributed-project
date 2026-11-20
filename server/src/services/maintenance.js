// Background jobs every branch runs on boot and then every minute. Each job is independent: one failing
// (e.g. a peer down) never stops the others.
const config = require("../config/env");
const Library = require("../models/Library");
const recoveryService = require("./recoveryService");
const userService = require("./userService");

const EVERY_MS = 60_000;

// A requested copy nobody picked up in time goes back on the shelf.
async function releaseExpiredHolds(now = new Date()) {
  const r = await Library.updateMany(
    { currentBranch: config.branchId, status: "ON_HOLD", holdExpiresAt: { $lte: now } },
    { $set: { status: "AVAILABLE", heldFor: null, holdExpiresAt: null } },
  );
  return { released: r.modifiedCount };
}

const jobs = {
  sagaRecovery: () => recoveryService.sweep(),
  expiredHolds: () => releaseExpiredHolds(),
  duplicateEmails: () => userService.reconcileDuplicates(),
};

async function runOnce() {
  const report = {};
  for (const [name, job] of Object.entries(jobs)) {
    try {
      report[name] = await job();
    } catch (err) {
      report[name] = { error: err.message };
    }
  }
  return report;
}

const changed = (r) => JSON.stringify(r).match(/"(committed|rolledBack|unlocked|pending|flagged)":[[^]]|"released":[1-9]|"error"/);

let timer = null;
function start() {
  if (timer) return;
  const tick = () => runOnce().then((r) => changed(r) && console.log(`[${config.branchId}] maintenance`, JSON.stringify(r)));
  setTimeout(tick, 5_000).unref(); // let the first heartbeats run so reconciliation can see the peers
  timer = setInterval(tick, EVERY_MS);
  timer.unref();
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { runOnce, releaseExpiredHolds, start, stop };
