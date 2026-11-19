// Federated lookup: check this branch first; on a miss ask every healthy peer in parallel.
// Branches may sit in different timezones with skewed wall clocks, so ordering uses the Lamport clock, never Date.
const Library = require("../models/Library");
const lamportClock = require("../utils/lamportClock");
const discoveryService = require("./discoveryService");
const config = require("../config/env");

async function askPeer(peer, isbn10) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.peerTimeoutMs);
  try {
    const res = await fetch(`${peer.url}/internal/books/${encodeURIComponent(isbn10)}`, {
      headers: {
        "x-source-branch": config.branchId,
        "x-internal-secret": config.internalSecret,
        "x-lamport-timestamp": String(lamportClock.tick()),
      },
      signal: controller.signal,
    });
    const remoteTick = Number(res.headers.get("x-lamport-timestamp") || 0);
    if (remoteTick > 0) lamportClock.sync(remoteTick);

    if (res.status === 404) return { branch: peer.branch, found: false };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return { branch: peer.branch, found: true, book: body.book, lamportTimestamp: remoteTick };
  } finally {
    clearTimeout(timeout);
  }
}

async function findBook(isbn10) {
  const local = await Library.findOne({ isbn10, currentBranch: config.branchId, status: "AVAILABLE" });
  if (local) return { isbn10, source: "local", foundAt: [{ branch: config.branchId, book: local }], offline: [] };

  const peers = discoveryService.getHealthyPeers();
  const results = await Promise.allSettled(peers.map((peer) => askPeer(peer, isbn10)));

  const foundAt = [];
  const offline = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") offline.push(peers[i].branch); // timeout or error: degrade, don't fail the search
    else if (r.value.found) foundAt.push(r.value);
  });
  return { isbn10, source: "peers", foundAt, offline };
}

module.exports = { findBook };
