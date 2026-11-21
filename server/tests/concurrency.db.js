// Fires parallel checkouts/transfers at the last available copy against a REAL MongoDB
// (atomicity can't be proven against a mock). CI: the throwaway mongo service. Locally: MONGO_URI_OSHAWA (Atlas).
// Only touches rows with isbn10 starting "TEST-CC-" and deletes them afterwards.
process.env.BRANCH_ID = "oshawa";
process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.PEER_TIMEOUT_MS = "2000";

const http = require("node:http");
const mongoose = require("mongoose");
const request = require("supertest");
const env = require("../src/config/env");
const app = require("../src/server");
const Library = require("../src/models/Library");
const TransferLog = require("../src/models/TransferLog");
const transferSaga = require("../src/services/transferSaga");
const discoveryService = require("../src/services/discoveryService");
const { signToken } = require("../src/middlewares/auth");

jest.setTimeout(30000);

const PREFIX = /^TEST-CC-/;
const tokenFor = (userId) => `Bearer ${signToken({ _id: userId, role: "patron", homeBranch: "oshawa" })}`;
const checkout = (isbn10, userId = "user-1") =>
  request(app).post("/api/circulation/checkout").set("Authorization", tokenFor(userId)).send({ isbn10 });
const makeBook = (isbn10, over = {}) =>
  Library.create({ isbn10, title: `Copy ${isbn10}`, currentBranch: "oshawa", status: "AVAILABLE", activeTransferId: null, ...over });

let peer;

beforeAll(async () => {
  // runtimeAdapters: driver 7.9 loads `os` via dynamic import(), which Jest's VM can't do; without it the
  // handshake goes out empty and mongo:7/8.3 reject it ("Missing required sub-document 'driver'").
  // serverSelectionTimeoutMS: fail in 5s with the real reason instead of hitting the 30s hook timeout.
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000, runtimeAdapters: { os: require("node:os") } });
  // Fake "ajax" peer that accepts every transfer, so the transfer saga can actually commit.
  peer = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(201, { "Content-Type": "application/json", "x-lamport-timestamp": "1" });
      res.end(JSON.stringify({ message: "ok" }));
    });
  });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  discoveryService.peers.set("ajax", { branch: "ajax", url: `http://127.0.0.1:${peer.address().port}`, healthy: true, consecutiveFailures: 0 });
});

beforeEach(async () => {
  await Library.deleteMany({ isbn10: PREFIX });
  await TransferLog.deleteMany({ bookIsbn: PREFIX });
});

afterAll(async () => {
  await Library.deleteMany({ isbn10: PREFIX });
  await TransferLog.deleteMany({ bookIsbn: PREFIX });
  await mongoose.connection.close();
  peer.closeAllConnections();
  await new Promise((r) => peer.close(r));
});

test("only one of 10 parallel checkouts wins the last copy", async () => {
  await makeBook("TEST-CC-001");

  const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => checkout("TEST-CC-001", `user-${i}`)));

  const winners = responses.filter((r) => r.status === 200);
  const losers = responses.filter((r) => r.status === 409);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(9);
  losers.forEach((r) => expect(r.body.code).toBe("BOOK_UNAVAILABLE"));

  const book = await Library.findOne({ isbn10: "TEST-CC-001" }).lean();
  expect(book.status).toBe("BORROWED");
  expect(book.borrowedBy).toBe(winners[0].body.book.borrowedBy);
});

test("checkout racing a transfer of the same copy: exactly one wins, and the DB agrees with the winner", async () => {
  for (let i = 0; i < 5; i += 1) {
    const isbn10 = `TEST-CC-1${i}`;
    await makeBook(isbn10);

    const [co, tr] = await Promise.allSettled([
      checkout(isbn10, "racer"),
      transferSaga.executeTransfer({ isbn10, targetBranch: "ajax" }),
    ]);
    const checkoutWon = co.status === "fulfilled" && co.value.status === 200;
    const transferWon = tr.status === "fulfilled";

    expect(checkoutWon !== transferWon).toBe(true); // exactly one
    const book = await Library.findOne({ isbn10 }).lean();
    if (checkoutWon) {
      expect(tr.reason.statusCode).toBe(409);
      expect(book).toMatchObject({ status: "BORROWED", borrowedBy: "racer", activeTransferId: null });
    } else {
      // 409 if the copy was still locked when checkout looked, 404 if it had already left for ajax.
      expect([409, 404]).toContain(co.value.status);
      expect(book).toBeNull(); // moved to ajax
    }
  }
});

test("a copy that is in transit cannot be checked out", async () => {
  await makeBook("TEST-CC-002", { status: "IN_TRANSIT", activeTransferId: "saga-x" });
  const res = await checkout("TEST-CC-002");
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("BOOK_UNAVAILABLE");
});

test("a borrowed copy cannot be transferred away", async () => {
  await makeBook("TEST-CC-003", { status: "BORROWED", borrowedBy: "someone" });
  await expect(transferSaga.executeTransfer({ isbn10: "TEST-CC-003", targetBranch: "ajax" }))
    .rejects.toMatchObject({ statusCode: 409 });
});

test("checkout validates input and auth", async () => {
  expect((await checkout("TEST-CC-404")).status).toBe(404);
  expect((await checkout("TEST-CC-404")).body.code).toBe("BOOK_NOT_FOUND");
  expect((await checkout(undefined)).status).toBe(400);
  expect((await request(app).post("/api/circulation/checkout").send({ isbn10: "TEST-CC-001" })).status).toBe(401);
});
