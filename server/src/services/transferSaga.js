// distributed Saga pattern to safely transfer a book record from one library branch database to another over HTTP
// uses Lamport timestamps to track event ordering across nodes
const { v4: uuidv4 } = require("uuid");
const Library = require("../models/Library");
const TransferLog = require("../models/TransferLog");
const lamportClock = require("../utils/lamportClock");
const discoveryService = require("./discoveryService");
const config = require("../config/env");
const AppError = require("../utils/AppError");

async function callPeerBranch(targetBranch, path, payload, tick) {
  const baseUrl = discoveryService.getPeerUrl(targetBranch);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.peerTimeoutMs);

  try {
    const response = await fetch(`${baseUrl}/internal${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-source-branch": config.branchId,
        "x-internal-secret": config.internalSecret,
        "x-lamport-timestamp": String(tick),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const remoteTick = Number(response.headers.get("x-lamport-timestamp") || 0);
    if (remoteTick > 0) {
      lamportClock.sync(remoteTick);
    }

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new AppError(
        errBody.message || `Peer '${targetBranch}' rejected transfer (HTTP ${response.status})`,
        response.status,
      );
    }

    return await response.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw AppError.serviceUnavailable(
        `Peer '${targetBranch}' timed out after ${config.peerTimeoutMs}ms`,
        "PEER_TIMEOUT",
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function executeTransfer({ isbn10, targetBranch }) {
  const sourceBranch = config.branchId;
  const normalizedTarget = targetBranch.toLowerCase();

  // Fail fast if targetBranch is self, unknown, or marked offline
  discoveryService.getPeerUrl(normalizedTarget);

  const sagaId = uuidv4();
  const initialTick = lamportClock.tick();

  // Step 1 (Local Atomic Lock): Lock row on source DB across both container replicas
  const reservedBook = await Library.findOneAndUpdate(
    {
      isbn10,
      currentBranch: sourceBranch,
      status: { $in: ["AVAILABLE", null] },
      activeTransferId: null,
    },
    {
      $set: {
        status: "IN_TRANSIT",
        activeTransferId: sagaId,
      },
    },
    { returnDocument: "after" },
  );

  if (!reservedBook) {
    throw AppError.conflict(
      `Book '${isbn10}' is not available at branch '${sourceBranch}' or is already in transit`,
      "BOOK_UNAVAILABLE",
    );
  }

  const sagaLog = await TransferLog.create({
    sagaId,
    bookIsbn: reservedBook.isbn10,
    sourceBranch,
    targetBranch: normalizedTarget,
    status: "RESERVED",
    lamportTimestamp: initialTick,
  });

  try {
    // Step 2 (Remote Replicate): Send row payload to target branch
    const tickForPeer = lamportClock.tick();
    const bookData = reservedBook.toObject();
    delete bookData._id;
    delete bookData.__v;
    delete bookData.createdAt;
    delete bookData.updatedAt;
    delete bookData.activeTransferId;

    await callPeerBranch(
      normalizedTarget,
      "/transfers/receive",
      {
        sagaId,
        sourceBranch,
        bookData: {
          ...bookData,
          currentBranch: normalizedTarget,
          status: "AVAILABLE",
        },
      },
      tickForPeer,
    );

    // Step 3 (Local Finalize): Delete row from source DB
    await Library.deleteOne({ _id: reservedBook._id, activeTransferId: sagaId });

    sagaLog.status = "COMMITTED";
    sagaLog.lamportTimestamp = lamportClock.tick();
    await sagaLog.save();

    return {
      sagaId,
      status: "COMMITTED",
      isbn10: reservedBook.isbn10,
      title: reservedBook.title,
      from: sourceBranch,
      to: normalizedTarget,
    };
  } catch (error) {
    // Step 4 (Compensate): Roll back lock on source DB if remote write failed
    sagaLog.status = "COMPENSATING";
    sagaLog.errorReason = error.message;
    await sagaLog.save();

    await Library.updateOne(
      { _id: reservedBook._id, activeTransferId: sagaId },
      {
        $set: {
          status: "AVAILABLE",
          activeTransferId: null,
        },
      },
    );

    sagaLog.status = "ROLLED_BACK";
    sagaLog.lamportTimestamp = lamportClock.tick();
    await sagaLog.save();

    throw error;
  }
}
// Step 5 (Party)
module.exports = { executeTransfer };
