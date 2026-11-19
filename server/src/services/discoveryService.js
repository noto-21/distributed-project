// singleton used to track, health-check, and route requests between peer nodes in a distributed cluster
const AppError = require("../utils/AppError");
const config = require("../config/env");

const HEARTBEAT_INTERVAL_MS = config.discoveryIntervalMs; // 5000ms from DISCOVERY_INTERVAL_MS in docker-compose.yml
const HEALTH_TIMEOUT_MS = config.peerTimeoutMs; // 3000ms from PEER_TIMEOUT_MS in docker-compose.yml
const FAILURE_THRESHOLD = 3;

class DiscoveryService {
  constructor() {
    this.selfBranch = config.branchId; // 'oshawa' | 'ajax' | 'whitby'
    this.internalSecret = config.internalSecret;
    this.peers = new Map();
    this.heartbeatTimer = null;
    this._initRegistry();
  }

  _initRegistry() {
    // config.peers is already validated and filtered against selfBranch by env.js
    Object.entries(config.peers).forEach(([branch, url]) => {
      const normalizedBranch = branch.toLowerCase();
      if (normalizedBranch === this.selfBranch) return;

      this.peers.set(normalizedBranch, {
        branch: normalizedBranch,
        url,
        healthy: true,
        consecutiveFailures: 0,
        lastChecked: null,
        lastHealthyAt: null,
        latencyMs: null,
        lamportClock: 0,
      });
    });
  }

  // Starts periodic background health checks for all peer branches.
  start() {
    if (this.heartbeatTimer) return;

    // Run an immediate probe on boot, then schedule interval
    this.checkAllPeers().catch(() => {});

    this.heartbeatTimer = setInterval(() => {
      this.checkAllPeers().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);

    // Prevent timer from blocking Node.js SIGTERM graceful shutdown
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  // Stops background health checks during graceful shutdown.
  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // Probes all registered peer nodes concurrently.
  async checkAllPeers() {
    const checks = Array.from(this.peers.keys()).map((branch) => this.probePeer(branch));
    await Promise.allSettled(checks);
    return this.getClusterTopology();
  }

  /**
   * Sends a lightweight HTTP health probe to a specific peer branch.
   * Note: With `deploy.replicas: 2` in docker-compose.yml, Docker DNS load-balances
   * requests across both container instances for the target branch.
   * @param {string} branchName
   */
  async probePeer(branchName) {
    const key = String(branchName || "").toLowerCase();
    const peer = this.peers.get(key);
    if (!peer) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const startTime = Date.now();

    try {
      const response = await fetch(`${peer.url}/internal/health`, {
        method: "GET",
        cache: "no-store",
        headers: {
          "x-source-branch": this.selfBranch,
          "x-internal-secret": this.internalSecret,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json().catch(() => ({}));
      const now = new Date().toISOString();

      peer.healthy = true;
      peer.consecutiveFailures = 0;
      peer.lastChecked = now;
      peer.lastHealthyAt = now;
      peer.latencyMs = Date.now() - startTime;

      // Monotonic update prevents clock regression when Docker DNS alternates between replicas
      if (typeof data.lamportClock === "number") {
        peer.lamportClock = Math.max(peer.lamportClock, data.lamportClock);
      }
    } catch (err) {
      clearTimeout(timeoutId);
      peer.consecutiveFailures += 1;
      peer.lastChecked = new Date().toISOString();
      peer.latencyMs = null;

      if (peer.consecutiveFailures >= FAILURE_THRESHOLD) {
        peer.healthy = false;
      }
    }

    return { ...peer };
  }

  /**
   * Resolves a specific target peer's base URL, throwing a 503 AppError if unreachable.
   * Used by transferSaga when locking/transferring inventory on a remote branch.
   * @param {string} branchName
   */
  getPeerUrl(branchName) {
    const key = String(branchName || "").toLowerCase();

    if (key === this.selfBranch) {
      throw AppError.badRequest(
        `Target branch ${branchName} is the local node`,
        "INVALID_PEER_TARGET",
      );
    }

    const peer = this.peers.get(key);
    if (!peer) {
      throw AppError.notFound(`Unknown branch ${branchName}`, "UNKNOWN_BRANCH");
    }

    if (!peer.healthy) {
      throw AppError.serviceUnavailable(
        `Branch ${branchName} is currently offline or failing health checks`,
        "PEER_OFFLINE",
        {
          branch: key,
          consecutiveFailures: peer.consecutiveFailures,
          lastHealthyAt: peer.lastHealthyAt,
        },
      );
    }

    return peer.url;
  }

  // Returns all currently healthy peer nodes (for scatter-gather catalog/recommendation queries).
  getHealthyPeers() {
    return Array.from(this.peers.values())
      .filter((peer) => peer.healthy)
      .map((peer) => ({ ...peer }));
  }

  // Selects the lowest-latency healthy peer for read failover or fallback routing.
  getBestAvailablePeer() {
    const healthy = this.getHealthyPeers();
    if (healthy.length === 0) {
      throw AppError.serviceUnavailable(
        "No healthy peer branches available in cluster",
        "CLUSTER_DEGRADED",
      );
    }

    return healthy.sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))[0];
  }

  // Returns full cluster state including the local node.
  getClusterTopology() {
    return {
      self: {
        branch: this.selfBranch,
        healthy: true,
        role: "local",
      },
      peers: Array.from(this.peers.values()).map((peer) => ({ ...peer })),
    };
  }
}

module.exports = new DiscoveryService();
