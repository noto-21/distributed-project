// Circulation + failure scenarios against a REAL MongoDB (npm run test:db; CI's mongo service, or Atlas locally).
// This process is the OSHAWA branch, listening on a real port. ajax and whitby are fake peers on local ports;
// the fake whitby really delivers its copy by calling oshawa's /internal/transfers/receive, like a live branch.
// Only touches isbn10 "TEST-CR-*" rows and deletes them afterwards.
process.env.BRANCH_ID = "oshawa";
process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.PEER_TIMEOUT_MS = "800";

const http = require("node:http");
const mongoose = require("mongoose");
const request = require("supertest");
const env = require("../src/config/env");
const app = require("../src/server");
const Library = require("../src/models/Library");
const TransferLog = require("../src/models/TransferLog");
const Loan = require("../src/models/Loan");
const discoveryService = require("../src/services/discoveryService");
const recoveryService = require("../src/services/recoveryService");
const lamportClock = require("../src/utils/lamportClock");
const { signToken } = require("../src/middlewares/auth");

jest.setTimeout(30000);

const PREFIX = /^TEST-CR-/;
const SECRET = { "x-internal-secret": "test-internal-secret", "Content-Type": "application/json" };
const patron = (homeBranch = "oshawa", userId = "pat-1") => `Bearer ${signToken({ _id: userId, role: "patron", homeBranch })}`;
const librarian = `Bearer ${signToken({ _id: "lib-1", role: "librarian", homeBranch: "oshawa" })}`;
const makeBook = (isbn10, over = {}) => Library.create({ isbn10, title: `Copy ${isbn10}`, currentBranch: "oshawa", ...over });

let oshawaUrl;
let oshawaServer;
const fake = {}; // branch -> { server, url, behave, seen }

// A fake peer branch. `behave(req, body)` returns [status, json] or null (= never answer: crashed/hung).
async function startFake(branch) {
  const peer = { seen: [], behave: () => [404, {}] };
  peer.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : {};
      peer.seen.push({ method: req.method, url: req.url, body, headers: req.headers });
      const out = await peer.behave(req, body);
      if (!out) return; // hang
      res.writeHead(out[0], { "Content-Type": "application/json", "x-lamport-timestamp": "1000" });
      res.end(JSON.stringify(out[1]));
    });
  });
  await new Promise((r) => peer.server.listen(0, "127.0.0.1", r));
  peer.url = `http://127.0.0.1:${peer.server.address().port}`;
  fake[branch] = peer;
}

const healthy = (branch, ok = true) => discoveryService.peers.set(branch, { branch, url: fake[branch].url, healthy: ok, consecutiveFailures: ok ? 0 : 3 });

// What a real whitby does on /internal/transfers/send: run its saga, i.e. deliver the copy to the target.
async function whitbyDelivers(body, { isbn10, title }) {
  const res = await fetch(`${oshawaUrl}/internal/transfers/receive`, {
    method: "POST",
    headers: { ...SECRET, "x-lamport-timestamp": "500" },
    body: JSON.stringify({
      sagaId: `saga-${isbn10}`,
      sourceBranch: "whitby",
      bookData: { isbn10, title, originBranch: "whitby", custodyHistory: [] },
    }),
  });
  return res.ok ? [200, { transfer: { sagaId: `saga-${isbn10}`, status: "COMMITTED", from: "whitby", to: body.targetBranch } }] : [500, {}];
}

beforeAll(async () => {
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000, runtimeAdapters: { os: require("node:os") } });
  oshawaServer = app.listen(0, "127.0.0.1");
  await new Promise((r) => oshawaServer.once("listening", r));
  oshawaUrl = `http://127.0.0.1:${oshawaServer.address().port}`;
  await startFake("ajax");
  await startFake("whitby");
});

beforeEach(async () => {
  await Promise.all([Library.deleteMany({ isbn10: PREFIX }), TransferLog.deleteMany({ bookIsbn: PREFIX }), Loan.deleteMany({ isbn10: PREFIX })]);
  for (const b of ["ajax", "whitby"]) { fake[b].seen = []; fake[b].behave = () => [404, {}]; healthy(b); }
});

afterAll(async () => {
  await Promise.all([Library.deleteMany({ isbn10: PREFIX }), TransferLog.deleteMany({ bookIsbn: PREFIX }), Loan.deleteMany({ isbn10: PREFIX })]);
  await mongoose.connection.close();
  for (const s of [oshawaServer, fake.ajax.server, fake.whitby.server]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
});

describe("patron requests a book to their home branch", () => {
  const ask = (isbn10, token = patron()) => request(app).post("/api/circulation/requests").set("Authorization", token).send({ isbn10 });

  test("book only at whitby -> whitby sends it, and the copy really lands in oshawa's DB with its custody record", async () => {
    const book = { isbn10: "TEST-CR-001", title: "Gilead" };
    fake.whitby.behave = (req, body) => {
      if (req.url.startsWith("/internal/books/")) return [200, { found: true, book }];
      if (req.url === "/internal/transfers/send") return whitbyDelivers(body, book);
      return [404, {}];
    };

    const res = await ask(book.isbn10);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "TRANSFERRED", from: "whitby", to: "oshawa" });
    expect(fake.whitby.seen.find((r) => r.url === "/internal/transfers/send").body).toEqual({ isbn10: book.isbn10, targetBranch: "oshawa" });
    const here = await Library.findOne({ isbn10: book.isbn10 }).lean();
    expect(here).toMatchObject({ currentBranch: "oshawa", status: "AVAILABLE", originBranch: "whitby" });
    expect(here.custodyHistory).toEqual([expect.objectContaining({ event: "TRANSFER_IN", branch: "oshawa", from: "whitby" })]);
    expect(here.custodyHistory[0].lamport).toBeGreaterThan(500); // receive event after whitby's 500
  });

  test("first holder lost the copy to someone else (409) -> the next holder is asked", async () => {
    const book = { isbn10: "TEST-CR-002", title: "Dune" };
    fake.ajax.behave = (req) => (req.url.startsWith("/internal/books/") ? [200, { found: true, book }] : [409, { code: "BOOK_UNAVAILABLE" }]);
    fake.whitby.behave = (req, body) => (req.url.startsWith("/internal/books/") ? [200, { found: true, book }] : whitbyDelivers(body, book));

    const res = await ask(book.isbn10);

    expect(res.status).toBe(200);
    expect(res.body.from).toBe("whitby");
  });

  test("already on the shelf at home -> no transfer", async () => {
    await makeBook("TEST-CR-003");
    const res = await ask("TEST-CR-003");
    expect(res.body.status).toBe("AVAILABLE_HERE");
    expect(fake.whitby.seen).toHaveLength(0);
  });

  test("nobody has it / the only holder is down -> 404 with a warning naming the down branch", async () => {
    healthy("whitby", false);
    const res = await ask("TEST-CR-404");
    expect(res.status).toBe(404);
    expect(res.body.warning).toMatch(/whitby/);
  });

  test("must be made at your home branch", async () => {
    const res = await ask("TEST-CR-001", patron("ajax"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_HOME_BRANCH");
  });
});

describe("checkout, return, loans and custody history", () => {
  const post = (path, isbn10, token = patron()) => request(app).post(`/api/circulation/${path}`).set("Authorization", token).send({ isbn10 });

  test("checkout -> return records a Loan and a Lamport-ordered custody trail", async () => {
    await makeBook("TEST-CR-010");
    expect((await post("checkout", "TEST-CR-010")).status).toBe(200);
    const ret = await post("return", "TEST-CR-010");
    expect(ret.status).toBe(200);
    expect(ret.body.routedTo).toBeNull(); // its home is oshawa

    const book = await Library.findOne({ isbn10: "TEST-CR-010" }).lean();
    expect(book).toMatchObject({ status: "AVAILABLE", borrowedBy: null, originBranch: "oshawa" });
    expect(book.custodyHistory.map((e) => e.event)).toEqual(["CHECKOUT", "RETURN"]);
    expect(book.custodyHistory[1].lamport).toBeGreaterThan(book.custodyHistory[0].lamport);

    const loans = (await request(app).get("/api/circulation/loans/me").set("Authorization", patron())).body.loans;
    expect(loans).toEqual([expect.objectContaining({ isbn10: "TEST-CR-010", status: "RETURNED" })]);
    expect(loans[0].returnLamport).toBeGreaterThan(loans[0].checkoutLamport);
  });

  test("custody stays in Lamport order even when the next event hits a replica whose clock is behind", async () => {
    // Each branch runs 2 replicas, each with its own in-memory clock. Replica A received the copy at a high
    // Lamport time; replica B (clock still low) handles the checkout.
    await makeBook("TEST-CR-015", { custodyHistory: [{ event: "TRANSFER_IN", branch: "oshawa", from: "whitby", lamport: 900 }] });
    lamportClock.time = 3; // we are replica B

    await post("checkout", "TEST-CR-015");
    lamportClock.time = 1; // the return lands on yet another lagging replica
    await post("return", "TEST-CR-015");

    const trail = (await Library.findOne({ isbn10: "TEST-CR-015" }).lean()).custodyHistory.map((e) => e.lamport);
    expect(trail[1]).toBeGreaterThan(trail[0]);
    expect(trail[2]).toBeGreaterThan(trail[1]);
    const [loan] = (await request(app).get("/api/circulation/loans/me").set("Authorization", patron())).body.loans;
    expect(loan.checkoutLamport).toBeGreaterThan(900);
  });

  test("a received copy is stamped after its history, even if the sending replica's clock was behind", async () => {
    const res = await fetch(`${oshawaUrl}/internal/transfers/receive`, {
      method: "POST",
      headers: { ...SECRET, "x-lamport-timestamp": "2" }, // lagging sender replica
      body: JSON.stringify({
        sagaId: "saga-TEST-CR-016",
        sourceBranch: "ajax",
        bookData: { isbn10: "TEST-CR-016", title: "Lag", custodyHistory: [{ event: "RETURN", branch: "ajax", lamport: 5000 }] },
      }),
    });
    expect(res.status).toBe(201);
    const trail = (await Library.findOne({ isbn10: "TEST-CR-016" }).lean()).custodyHistory;
    expect(trail[1]).toMatchObject({ event: "TRANSFER_IN", branch: "oshawa" });
    expect(trail[1].lamport).toBeGreaterThan(5000);
  });

  test("only the borrower can return it", async () => {
    await makeBook("TEST-CR-011");
    await post("checkout", "TEST-CR-011", patron("oshawa", "alice"));
    const res = await post("return", "TEST-CR-011", patron("oshawa", "mallory"));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_BORROWED_BY_YOU");
  });

  test("a returned copy whose home is ajax is sent back to ajax", async () => {
    await makeBook("TEST-CR-012", { originBranch: "ajax" });
    fake.ajax.behave = (req) => (req.url === "/internal/transfers/receive" ? [201, { message: "ok" }] : [404, {}]);
    await post("checkout", "TEST-CR-012");

    const res = await post("return", "TEST-CR-012");

    expect(res.body.routedTo).toBe("ajax");
    const sent = fake.ajax.seen.find((r) => r.url === "/internal/transfers/receive").body;
    expect(sent.bookData).toMatchObject({ originBranch: "ajax", currentBranch: "ajax" });
    expect(sent.bookData.custodyHistory.map((e) => e.event)).toEqual(["CHECKOUT", "RETURN"]); // history travels with the copy
    expect(await Library.findOne({ isbn10: "TEST-CR-012" })).toBeNull();
  });

  test("home branch down at return time -> stays available here with a warning", async () => {
    await makeBook("TEST-CR-013", { originBranch: "ajax" });
    healthy("ajax", false);
    await post("checkout", "TEST-CR-013");

    const res = await post("return", "TEST-CR-013");

    expect(res.status).toBe(200);
    expect(res.body.routedTo).toBeNull();
    expect(res.body.warning).toMatch(/ajax/);
    expect((await Library.findOne({ isbn10: "TEST-CR-013" })).status).toBe("AVAILABLE");
  });

  test("manual transfers are librarian-only", async () => {
    await makeBook("TEST-CR-014");
    const body = { isbn10: "TEST-CR-014", targetBranch: "ajax" };
    expect((await request(app).post("/api/circulation/transfers").send(body)).status).toBe(401);
    expect((await request(app).post("/api/circulation/transfers").set("Authorization", patron()).send(body)).status).toBe(403);
    fake.ajax.behave = () => [201, { message: "ok" }];
    expect((await request(app).post("/api/circulation/transfers").set("Authorization", librarian).send(body)).status).toBe(200);
  });
});

describe("failure demo: a branch dies mid-transfer", () => {
  test("target hangs -> source times out, compensates, and the log shows the steps in Lamport order", async () => {
    await makeBook("TEST-CR-020");
    fake.ajax.behave = () => null; // ajax accepts the connection, then never answers (crashed mid-request)

    const res = await request(app).post("/api/circulation/transfers").set("Authorization", librarian).send({ isbn10: "TEST-CR-020", targetBranch: "ajax" });

    expect(res.status).toBe(503);
    expect((await Library.findOne({ isbn10: "TEST-CR-020" })).toObject()).toMatchObject({ status: "AVAILABLE", activeTransferId: null });
    const log = await TransferLog.findOne({ bookIsbn: "TEST-CR-020" });
    expect(log.status).toBe("ROLLED_BACK");
    expect(log.errorReason).toMatch(/timed out/);
  });

  // The source itself "crashes": we leave the state a crash would leave, then run the recovery sweep.
  async function crashedMidSaga(isbn10, status = "RESERVED") {
    const sagaId = `saga-crash-${isbn10}`;
    await makeBook(isbn10, { status: "IN_TRANSIT", activeTransferId: sagaId });
    await TransferLog.create({ sagaId, bookIsbn: isbn10, sourceBranch: "oshawa", targetBranch: "ajax", status, lamportTimestamp: 1 });
    return sagaId;
  }

  test("source crashed after the target committed -> recovery finishes the transfer (no duplicate copy)", async () => {
    const sagaId = await crashedMidSaga("TEST-CR-030");
    fake.ajax.behave = (req) => (req.url.startsWith(`/internal/transfers/${sagaId}`) ? [200, { sagaId, status: "COMMITTED" }] : [404, {}]);

    const report = await recoveryService.sweep({ olderThanMs: 0 });

    expect(report.committed).toContain(sagaId);
    expect(await Library.findOne({ isbn10: "TEST-CR-030" })).toBeNull();
    expect((await TransferLog.findOne({ sagaId })).status).toBe("COMMITTED");
  });

  test("source crashed before the target got it -> recovery unlocks the copy (no lost copy)", async () => {
    const sagaId = await crashedMidSaga("TEST-CR-031");
    fake.ajax.behave = () => [404, { status: "UNKNOWN" }];

    const report = await recoveryService.sweep({ olderThanMs: 0 });

    expect(report.rolledBack).toContain(sagaId);
    expect((await Library.findOne({ isbn10: "TEST-CR-031" })).toObject()).toMatchObject({ status: "AVAILABLE", activeTransferId: null });
    expect((await TransferLog.findOne({ sagaId })).status).toBe("ROLLED_BACK");
  });

  test("target unreachable during recovery -> nothing is decided blind; retried on the next sweep", async () => {
    const sagaId = await crashedMidSaga("TEST-CR-032");
    healthy("ajax", false);

    const report = await recoveryService.sweep({ olderThanMs: 0 });

    expect(report.pending).toContain(sagaId);
    expect((await Library.findOne({ isbn10: "TEST-CR-032" })).status).toBe("IN_TRANSIT");
  });

  test("crashed while compensating -> recovery completes the rollback", async () => {
    const sagaId = await crashedMidSaga("TEST-CR-033", "COMPENSATING");
    const report = await recoveryService.sweep({ olderThanMs: 0 });
    expect(report.rolledBack).toContain(sagaId);
    expect((await Library.findOne({ isbn10: "TEST-CR-033" })).status).toBe("AVAILABLE");
  });

  test("crashed between taking the lock and writing the log -> orphaned lock is released", async () => {
    await makeBook("TEST-CR-034", { status: "IN_TRANSIT", activeTransferId: "saga-never-logged" });
    const report = await recoveryService.sweep({ olderThanMs: 0 });
    expect(report.unlocked).toContain("TEST-CR-034");
    expect((await Library.findOne({ isbn10: "TEST-CR-034" })).status).toBe("AVAILABLE");
  });

  test("fresh locks are left alone (a live saga is never touched)", async () => {
    await crashedMidSaga("TEST-CR-035");
    const report = await recoveryService.sweep(); // default 30s staleness
    expect(report.rolledBack).not.toContain("saga-crash-TEST-CR-035");
    expect(fake.ajax.seen).toHaveLength(0);
  });

  test("target side: a retried delivery after a crash is applied once", async () => {
    const deliver = () => fetch(`${oshawaUrl}/internal/transfers/receive`, {
      method: "POST",
      headers: SECRET,
      body: JSON.stringify({ sagaId: "saga-dup-TEST-CR-040", sourceBranch: "ajax", bookData: { isbn10: "TEST-CR-040", title: "Dup" } }),
    });
    expect((await deliver()).status).toBe(201);
    await TransferLog.deleteOne({ sagaId: "saga-dup-TEST-CR-040" }); // simulate: crashed before the log was written
    expect((await deliver()).status).toBe(200); // copy already here -> no duplicate, no 500
    expect(await Library.countDocuments({ isbn10: "TEST-CR-040" })).toBe(1);

    const status = await fetch(`${oshawaUrl}/internal/transfers/saga-unknown?isbn10=TEST-CR-040`, { headers: SECRET });
    expect((await status.json()).status).toBe("COMMITTED"); // copy present settles it even without a log
  });
});
