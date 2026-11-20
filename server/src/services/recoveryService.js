// Crash recovery for the transfer saga, run by the SOURCE branch on boot and then periodically.
// A crash mid-saga leaves a copy locked IN_TRANSIT. For each stale lock we ask the target what it saw:
//   target committed  -> finish: delete our copy, log COMMITTED
//   target never got it / we were already compensating -> undo: unlock the copy, log ROLLED_BACK
//   target unreachable -> leave it; decide on a later sweep (deciding blind could duplicate or lose a copy)
const Library = require("../models/Library");
const TransferLog = require("../models/TransferLog");
const lamportClock = require("../utils/lamportClock");
const config = require("../config/env");
const { callPeer } = require("./peerClient");

const STALE_MS = 30_000; // far longer than PEER_TIMEOUT_MS, so a live saga is never touched

async function settle(log, status, reason) {
  log.status = status;
  log.lamportTimestamp = lamportClock.tick();
  if (reason) log.errorReason = reason;
  await log.save();
}

async function sweep({ olderThanMs = STALE_MS } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs); // our own DB's timestamps only: no cross-branch clock compare
  const report = { committed: [], rolledBack: [], pending: [], unlocked: [] };

  const stuck = await TransferLog.find({
    sourceBranch: config.branchId,
    status: { $in: ["RESERVED", "COMPENSATING"] },
    updatedAt: { $lte: cutoff },
  });

  for (const log of stuck) {
    if (log.status === "RESERVED") {
      let remote;
      try {
        remote = await callPeer(log.targetBranch, "GET", `/transfers/${encodeURIComponent(log.sagaId)}?isbn10=${encodeURIComponent(log.bookIsbn)}`);
      } catch {
        report.pending.push(log.sagaId);
        continue;
      }
      if (remote.status === 200 && remote.body.status === "COMMITTED") {
        await Library.deleteOne({ activeTransferId: log.sagaId });
        await settle(log, "COMMITTED");
        report.committed.push(log.sagaId);
        continue;
      }
      if (remote.status !== 404) {
        report.pending.push(log.sagaId);
        continue;
      }
    }
    await Library.updateOne({ activeTransferId: log.sagaId }, { $set: { status: "AVAILABLE", activeTransferId: null } });
    await settle(log, "ROLLED_BACK", "Recovered after crash: target never committed");
    report.rolledBack.push(log.sagaId);
  }

  // Locked with no log at all: crashed between taking the lock and writing the RESERVED log.
  const locked = await Library.find({ currentBranch: config.branchId, status: "IN_TRANSIT", updatedAt: { $lte: cutoff } });
  for (const book of locked) {
    if (await TransferLog.exists({ sagaId: book.activeTransferId })) continue;
    await Library.updateOne({ _id: book._id, activeTransferId: book.activeTransferId }, { $set: { status: "AVAILABLE", activeTransferId: null } });
    report.unlocked.push(book.isbn10);
  }

  return report;
}

module.exports = { sweep };
