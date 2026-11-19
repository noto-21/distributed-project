// Peer failover: a dead or unhealthy branch must not break search. Reachable branches still answer,
// and the response names the branches that could not be asked. DB-free: Library is mocked.
process.env.BRANCH_ID = "oshawa";
process.env.MONGO_URI = "mongodb://localhost:27017/library_test";
process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.PEER_TIMEOUT_MS = "300";

jest.mock("../src/models/Library", () => ({ findOne: jest.fn() }));

const http = require("node:http");
const request = require("supertest");
const Library = require("../src/models/Library");
const discoveryService = require("../src/services/discoveryService");
const { findBook } = require("../src/services/catalogSearch");
const app = require("../src/server");

const BOOK = { isbn10: "0262033844", title: "Introduction to Algorithms" };
const servers = [];

// A live peer that has the book, plus a hit counter. `health: false` makes /internal/health return 500.
function livePeer({ hasBook = true, health = true } = {}) {
  const hits = { books: 0, health: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === "/internal/health") {
      hits.health += 1;
      res.writeHead(health ? 200 : 500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", lamportClock: 1 }));
    }
    hits.books += 1;
    res.writeHead(hasBook ? 200 : 404, { "Content-Type": "application/json", "x-lamport-timestamp": "2" });
    res.end(JSON.stringify(hasBook ? { found: true, book: BOOK } : { found: false }));
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${server.address().port}`, hits })));
}

// A port nobody listens on: connection refused, like a stopped container.
async function deadUrl() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

function setPeer(branch, url, healthy = true) {
  discoveryService.peers.set(branch, { branch, url, healthy, consecutiveFailures: healthy ? 0 : 3, lamportClock: 0 });
}

beforeEach(() => {
  discoveryService.peers.clear();
  Library.findOne.mockResolvedValue(null); // local miss at oshawa
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
  jest.resetAllMocks();
});

describe("search with a peer down", () => {
  test("returns partial results with a warning when a peer is unreachable", async () => {
    const ajax = await livePeer();
    setPeer("ajax", ajax.url);
    setPeer("whitby", await deadUrl());

    const result = await findBook(BOOK.isbn10);

    expect(result.foundAt.map((f) => f.branch)).toEqual(["ajax"]);
    expect(result.offline).toEqual(["whitby"]);
    expect(result.warning).toMatch(/whitby/);
  });

  test("a peer already marked unhealthy is skipped (no wasted timeout) but still reported offline", async () => {
    const ajax = await livePeer();
    const whitby = await livePeer();
    setPeer("ajax", ajax.url);
    setPeer("whitby", whitby.url, false);

    const result = await findBook(BOOK.isbn10);

    expect(whitby.hits.books).toBe(0);
    expect(result.foundAt.map((f) => f.branch)).toEqual(["ajax"]);
    expect(result.offline).toEqual(["whitby"]);
    expect(result.warning).toMatch(/whitby/);
  });

  test("no warning when every peer answered", async () => {
    setPeer("ajax", (await livePeer()).url);
    setPeer("whitby", (await livePeer({ hasBook: false })).url);

    const result = await findBook(BOOK.isbn10);

    expect(result.offline).toEqual([]);
    expect(result.warning).toBeUndefined();
  });

  test("all peers down -> public route answers JSON 404 with a warning, not a 500", async () => {
    setPeer("ajax", await deadUrl());
    setPeer("whitby", await deadUrl());

    const res = await request(app).get(`/api/circulation/books/${BOOK.isbn10}`);

    expect(res.status).toBe(404);
    expect(res.body.foundAt).toEqual([]);
    expect(res.body.offline.sort()).toEqual(["ajax", "whitby"]);
    expect(res.body.warning).toMatch(/ajax/);
  });

  test("local DB failure surfaces as a JSON 500 without leaking internals", async () => {
    Library.findOne.mockRejectedValue(new Error("connection pool exploded at 10.0.0.5"));

    const res = await request(app).get(`/api/circulation/books/${BOOK.isbn10}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error", code: "INTERNAL_ERROR" });
  });
});

describe("heartbeats (discoveryService)", () => {
  test("marks a peer unhealthy after 3 failed probes, and healthy again after one success", async () => {
    const peer = await livePeer({ health: false });
    setPeer("ajax", peer.url);

    await discoveryService.probePeer("ajax");
    await discoveryService.probePeer("ajax");
    expect(discoveryService.peers.get("ajax").healthy).toBe(true); // 2 failures: still trusted
    await discoveryService.probePeer("ajax");
    expect(discoveryService.peers.get("ajax").healthy).toBe(false);

    discoveryService.peers.get("ajax").url = (await livePeer()).url; // branch comes back
    await discoveryService.probePeer("ajax");
    expect(discoveryService.peers.get("ajax")).toMatchObject({ healthy: true, consecutiveFailures: 0 });
  });

  test("start() probes immediately and stop() cancels the timer", async () => {
    const peer = await livePeer();
    setPeer("ajax", peer.url);

    discoveryService.start();
    await new Promise((r) => setTimeout(r, 100));
    discoveryService.stop();

    expect(peer.hits.health).toBe(1);
    expect(discoveryService.heartbeatTimer).toBeNull();
  });
});
