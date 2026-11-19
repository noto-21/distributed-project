const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const mongoose = require("mongoose");

// Set test overrides BEFORE loading config/env (which loads Final_Project/.env)
process.env.BRANCH_ID = "oshawa";
process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.PEER_TIMEOUT_MS = "500";

const env = require("../src/config/env");
const Library = require("../src/models/Library");
const TransferLog = require("../src/models/TransferLog");
const transferSaga = require("../src/services/transferSaga");
const discoveryService = require("../src/services/discoveryService");
const internalController = require("../src/controllers/internalController");

describe("transferSaga Integration Tests", () => {
  let mockPeerServer;
  let mockPeerPort;
  let peerBehavior = "SUCCESS"; // "SUCCESS" | "FAIL_500" | "TIMEOUT"
  let receivedPayloads = [];

  before(async () => {
    await mongoose.connect(env.mongoUri);

    // Spin up a real local HTTP server acting as the "ajax" peer branch
    mockPeerServer = http.createServer((req, res) => {
      if (req.url === "/internal/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "ok", lamportClock: 5 }));
      }

      if (req.url === "/internal/transfers/receive" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          if (peerBehavior === "TIMEOUT") {
            // Never respond so AbortController triggers PEER_TIMEOUT
            return;
          }
          if (peerBehavior === "FAIL_500") {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ message: "Target Atlas write failed" }));
          }

          const parsed = JSON.parse(body);
          receivedPayloads.push({
            headers: req.headers,
            body: parsed,
          });

          res.writeHead(201, {
            "Content-Type": "application/json",
            "x-lamport-timestamp": "10",
          });
          res.end(JSON.stringify({ message: "Row transferred successfully" }));
        });
      }
    });

    await new Promise((resolve) => mockPeerServer.listen(0, "127.0.0.1", resolve));
    mockPeerPort = mockPeerServer.address().port;

    // Point discoveryService's "ajax" peer to our mock HTTP server
    discoveryService.peers.set("ajax", {
      branch: "ajax",
      url: `http://127.0.0.1:${mockPeerPort}`,
      healthy: true,
      consecutiveFailures: 0,
    });
  });

  after(async () => {
    discoveryService.stop();
    await Library.deleteMany({ isbn10: /^TEST-/ });
    await TransferLog.deleteMany({ bookIsbn: /^TEST-/ });
    await mongoose.connection.close();
    mockPeerServer.close();
  });

  beforeEach(async () => {
    peerBehavior = "SUCCESS";
    receivedPayloads = [];
    discoveryService.peers.get("ajax").healthy = true;
    await Library.deleteMany({ isbn10: /^TEST-/ });
    await TransferLog.deleteMany({ bookIsbn: /^TEST-/ });
  });

  it("1. Commits transfer, deletes source row, and syncs Lamport clock on success", async () => {
    await Library.create({
      isbn10: "TEST-001",
      title: "Distributed Systems",
      author: ["Maarten van Steen"],
      currentBranch: "oshawa",
      status: "AVAILABLE",
      activeTransferId: null,
    });

    const result = await transferSaga.executeTransfer({
      isbn10: "TEST-001",
      targetBranch: "ajax",
    });

    assert.equal(result.status, "COMMITTED");
    assert.equal(result.from, "oshawa");
    assert.equal(result.to, "ajax");

    // Verify peer received internal secret & Lamport header
    assert.equal(receivedPayloads.length, 1);
    assert.equal(receivedPayloads[0].headers["x-internal-secret"], "test-internal-secret");
    assert.ok(Number(receivedPayloads[0].headers["x-lamport-timestamp"]) > 0);
    assert.equal(receivedPayloads[0].body.bookData.currentBranch, "ajax");

    // Verify source DB deleted the transferred row & logged COMMITTED
    const sourceBook = await Library.findOne({ isbn10: "TEST-001" });
    assert.equal(sourceBook, null);

    const log = await TransferLog.findOne({ sagaId: result.sagaId });
    assert.equal(log.status, "COMMITTED");
  });

  it("2. Rolls back local lock to AVAILABLE when peer branch fails or times out", async () => {
    await Library.create({
      isbn10: "TEST-002",
      title: "Designing Data-Intensive Applications",
      author: ["Martin Kleppmann"],
      currentBranch: "oshawa",
      status: "AVAILABLE",
      activeTransferId: null,
    });

    peerBehavior = "TIMEOUT";

    await assert.rejects(
      () => transferSaga.executeTransfer({ isbn10: "TEST-002", targetBranch: "ajax" }),
      (err) => err.message.includes("timed out") && (err.statusCode === 503 || err.status === 503),
    );

    // Book must remain on Oshawa and be unlocked back to AVAILABLE
    const bookAfterRollback = await Library.findOne({ isbn10: "TEST-002" });
    assert.ok(bookAfterRollback);
    assert.equal(bookAfterRollback.status, "AVAILABLE");
    assert.equal(bookAfterRollback.activeTransferId, null);

    const log = await TransferLog.findOne({ bookIsbn: "TEST-002" });
    assert.equal(log.status, "ROLLED_BACK");
  });

  it("3. Prevents double-transfer under concurrent requests (atomic lock)", async () => {
    await Library.create({
      isbn10: "TEST-003",
      title: "Concurrency in Practice",
      author: ["Brian Goetz"],
      currentBranch: "oshawa",
      status: "AVAILABLE",
      activeTransferId: null,
    });

    // Fire two simultaneous transfers for the exact same book
    const [res1, res2] = await Promise.allSettled([
      transferSaga.executeTransfer({ isbn10: "TEST-003", targetBranch: "ajax" }),
      transferSaga.executeTransfer({ isbn10: "TEST-003", targetBranch: "ajax" }),
    ]);

    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
    const rejected = [res1, res2].filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.statusCode, 409);
    assert.equal(receivedPayloads.length, 1);
  });

  it("4. Target receiver handles duplicate sagaId deliveries idempotently", async () => {
    const req = {
      body: {
        sagaId: "saga-idempotent-999",
        sourceBranch: "ajax",
        bookData: {
          isbn10: "TEST-004",
          title: "Idempotent Microservices",
          author: ["Sam Newman"],
        },
      },
    };

    const makeRes = () => {
      const res = { statusCode: null, body: null, headers: {} };
      res.set = (k, v) => (res.headers[k] = v);
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
      res.json = (data) => {
        res.body = data;
        return res;
      };
      return res;
    };

    // First delivery -> 201 Created
    const res1 = makeRes();
    await internalController.receiveTransfer(req, res1, (err) => {
      throw err;
    });
    assert.equal(res1.statusCode, 201);

    // Retry delivery with same sagaId -> 200 OK without duplicate insert
    const res2 = makeRes();
    await internalController.receiveTransfer(req, res2, (err) => {
      throw err;
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body.message, "Transfer already applied");

    const count = await Library.countDocuments({ isbn10: "TEST-004" });
    assert.equal(count, 1);
  });
});
