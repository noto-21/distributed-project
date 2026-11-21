// One authenticated, Lamport-stamped HTTP call to a peer branch's /internal API.
// Returns { status, body } for any HTTP answer (callers decide what 404/409 mean);
// throws 503 AppError when the peer is unknown, marked offline, unreachable or times out.
const config = require("../config/env");
const lamportClock = require("../utils/lamportClock");
const discoveryService = require("./discoveryService");
const AppError = require("../utils/AppError");

async function callPeer(branch, method, path, body) {
  const baseUrl = discoveryService.getPeerUrl(branch);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.peerTimeoutMs);
  try {
    const res = await fetch(`${baseUrl}/internal${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-source-branch": config.branchId,
        "x-internal-secret": config.internalSecret,
        "x-lamport-timestamp": String(lamportClock.tick()),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    lamportClock.sync(res.headers.get("x-lamport-timestamp") ?? undefined);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (err) {
    if (err.isOperational) throw err;
    throw AppError.serviceUnavailable(
      err.name === "AbortError" ? `Peer '${branch}' timed out after ${config.peerTimeoutMs}ms` : `Peer '${branch}' unreachable`,
      "PEER_UNAVAILABLE",
    );
  } finally {
    clearTimeout(timeout);
  }
}

// Ask every healthy peer at once; resolves to [{ branch, status, body }] for the ones that answered.
async function callAllPeers(method, path, body) {
  const peers = discoveryService.getHealthyPeers();
  const results = await Promise.allSettled(peers.map((p) => callPeer(p.branch, method, path, body)));
  return results.flatMap((r, i) => (r.status === "fulfilled" ? [{ branch: peers[i].branch, ...r.value }] : []));
}

module.exports = { callPeer, callAllPeers };
