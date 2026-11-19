// Federated search: oshawa misses locally, asks ajax AND whitby in parallel, and whichever has the book answers.
// Peers live in different timezones with skewed wall clocks, so ordering is checked with Lamport timestamps only.
process.env.BRANCH_ID = "oshawa";
process.env.MONGO_URI = "mongodb://localhost:27017/library_test";
process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.PEER_TIMEOUT_MS = "300";

jest.mock("../src/models/Library", () => ({ findOne: jest.fn() }));

const http = require("node:http");
const request = require("supertest");
const Library = require("../src/models/Library");
const lamportClock = require("../src/utils/lamportClock");
const discoveryService = require("../src/services/discoveryService");
const { findBook } = require("../src/services/catalogSearch");
const app = require("../src/server");

const BOOK = { isbn10: "0262033844", title: "Introduction to Algorithms" };

// A fake peer branch. `hasBook` decides 200 vs 404; `lamport` is its own logical clock;
// `utcOffset` is only reported, to show wall time is never used for ordering.
function startPeer({ branch, hasBook, lamport, utcOffset, hang = false }) {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    if (hang) return; // never answer -> requester times out
    const localTime = new Date(Date.now() + utcOffset * 3600_000).toISOString().replace("Z", `${utcOffset >= 0 ? "+" : "-"}${String(Math.abs(utcOffset)).padStart(2, "0")}:00`);
    res.writeHead(hasBook ? 200 : 404, { "Content-Type": "application/json", "x-lamport-timestamp": String(lamport) });
    res.end(JSON.stringify(hasBook ? { found: true, branch, book: { ...BOOK, currentBranch: branch }, localTime } : { found: false, branch, localTime }));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` })),
  );
}

const peers = {};
async function setPeers(configs) {
  discoveryService.peers.clear();
  for (const cfg of configs) {
    peers[cfg.branch] = await startPeer(cfg);
    discoveryService.peers.set(cfg.branch, { branch: cfg.branch, url: peers[cfg.branch].url, healthy: true, consecutiveFailures: 0 });
  }
}

afterEach(async () => {
  await Promise.all(Object.values(peers).map((p) => new Promise((r) => { p.server.closeAllConnections(); p.server.close(r); })));
  for (const k of Object.keys(peers)) delete peers[k];
  jest.resetAllMocks();
});

describe("requesting branch (oshawa)", () => {
  test("local miss -> asks both peers; only the one holding the book (whitby) answers found", async () => {
    Library.findOne.mockResolvedValue(null); // not at oshawa
    await setPeers([
      { branch: "ajax", hasBook: false, lamport: 3, utcOffset: -5 },   // behind in wall time
      { branch: "whitby", hasBook: true, lamport: 50, utcOffset: +9 }, // ahead in wall time
    ]);

    const result = await findBook(BOOK.isbn10);

    // The request went to BOTH libraries, authenticated and Lamport-stamped
    for (const branch of ["ajax", "whitby"]) {
      expect(peers[branch].received).toHaveLength(1);
      expect(peers[branch].received[0].url).toBe(`/internal/books/${BOOK.isbn10}`);
      expect(peers[branch].received[0].headers["x-internal-secret"]).toBe("test-internal-secret");
      expect(Number(peers[branch].received[0].headers["x-lamport-timestamp"])).toBeGreaterThan(0);
    }

    // Only whitby reports having it
    expect(result.source).toBe("peers");
    expect(result.offline).toEqual([]);
    expect(result.foundAt).toHaveLength(1);
    expect(result.foundAt[0]).toMatchObject({ branch: "whitby", found: true, lamportTimestamp: 50 });
    expect(result.foundAt[0].book.title).toBe(BOOK.title);

    // Causality survives the timezone skew: oshawa's clock moved past every reply it received
    expect(lamportClock.now()).toBeGreaterThan(50);
  });

  test("book at both peers -> both answer found", async () => {
    Library.findOne.mockResolvedValue(null);
    await setPeers([
      { branch: "ajax", hasBook: true, lamport: 7, utcOffset: -5 },
      { branch: "whitby", hasBook: true, lamport: 9, utcOffset: +9 },
    ]);
    const result = await findBook(BOOK.isbn10);
    expect(result.foundAt.map((f) => f.branch).sort()).toEqual(["ajax", "whitby"]);
  });

  test("one peer hangs -> still gets the answer from the other and flags the slow one offline", async () => {
    Library.findOne.mockResolvedValue(null);
    await setPeers([
      { branch: "ajax", hasBook: true, lamport: 4, utcOffset: -5 },
      { branch: "whitby", hasBook: false, lamport: 0, utcOffset: +9, hang: true },
    ]);
    const result = await findBook(BOOK.isbn10);
    expect(result.foundAt.map((f) => f.branch)).toEqual(["ajax"]);
    expect(result.offline).toEqual(["whitby"]);
  });

  test("nobody has it -> empty result, and the public route returns 404", async () => {
    Library.findOne.mockResolvedValue(null);
    await setPeers([
      { branch: "ajax", hasBook: false, lamport: 1, utcOffset: -5 },
      { branch: "whitby", hasBook: false, lamport: 1, utcOffset: +9 },
    ]);
    const res = await request(app).get(`/api/circulation/books/${BOOK.isbn10}`);
    expect(res.status).toBe(404);
    expect(res.body.foundAt).toEqual([]);
  });

  test("local hit -> answers itself without asking any peer", async () => {
    Library.findOne.mockResolvedValue({ ...BOOK, currentBranch: "oshawa" });
    await setPeers([
      { branch: "ajax", hasBook: true, lamport: 1, utcOffset: -5 },
      { branch: "whitby", hasBook: true, lamport: 1, utcOffset: +9 },
    ]);
    const result = await findBook(BOOK.isbn10);
    expect(result.source).toBe("local");
    expect(peers.ajax.received).toHaveLength(0);
    expect(peers.whitby.received).toHaveLength(0);
  });
});

describe("answering branch (GET /internal/books/:isbn10)", () => {
  const ask = (headers = {}) =>
    request(app).get(`/internal/books/${BOOK.isbn10}`).set({ "x-internal-secret": "test-internal-secret", ...headers });

  test("has the book -> 200 with it, clock synced past the caller's", async () => {
    Library.findOne.mockResolvedValue({ ...BOOK, currentBranch: "oshawa" });
    const res = await ask({ "x-lamport-timestamp": "1000" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ found: true, branch: "oshawa" });
    expect(Number(res.headers["x-lamport-timestamp"])).toBeGreaterThan(1000);
    expect(Library.findOne).toHaveBeenCalledWith({ isbn10: BOOK.isbn10, currentBranch: "oshawa", status: "AVAILABLE" });
  });

  test("does not have it -> 404 found:false", async () => {
    Library.findOne.mockResolvedValue(null);
    const res = await ask();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ found: false, branch: "oshawa" });
  });

  test("rejects callers without the internal secret", async () => {
    const res = await request(app).get(`/internal/books/${BOOK.isbn10}`);
    expect(res.status).toBe(403);
    expect(Library.findOne).not.toHaveBeenCalled();
  });
});
