// Branch catalog retrieval: local branch queries MongoDB directly; remote branches forward via /internal/books.
process.env.BRANCH_ID = "oshawa";
process.env.MONGO_URI = "mongodb://localhost:27017/library_test";
process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.PEER_TIMEOUT_MS = "300";

jest.mock("../src/models/Library", () => ({
  find: jest.fn(),
  findOne: jest.fn(),
}));

const http = require("node:http");
const request = require("supertest");
const Library = require("../src/models/Library");
const lamportClock = require("../src/utils/lamportClock");
const discoveryService = require("../src/services/discoveryService");
const { signToken } = require("../src/middlewares/auth");
const { getAllEntriesByBranch } = require("../src/services/catalogSearch");
const app = require("../src/server");

const SAMPLE_BOOKS = {
  oshawa: [
    { isbn10: "0987654322", title: "OshawaBook1", currentBranch: "oshawa", status: "AVAILABLE" },
    { isbn10: "0123456789", title: "OshawaBook2", currentBranch: "oshawa", status: "BORROWED" },
  ],
  ajax: [
    { isbn10: "1449373321", title: "AjaxBook", currentBranch: "ajax", status: "AVAILABLE" },
  ],
  whitby: [
    { isbn10: "0262033844", title: "WhitbyBook", currentBranch: "whitby", status: "ON_HOLD" },
  ],
};

function startPeer({ branch, books = [], lamport = 10, hang = false }) {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    if (hang) return; // never answer -> requester times out
    res.writeHead(200, {
      "Content-Type": "application/json",
      "x-lamport-timestamp": String(lamport),
    });
    res.end(JSON.stringify({ branch, books }));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` })
    )
  );
}

const peers = {};
async function setPeers(configs) {
  discoveryService.peers.clear();
  for (const cfg of configs) {
    peers[cfg.branch] = await startPeer(cfg);
    discoveryService.peers.set(cfg.branch, {
      branch: cfg.branch,
      url: peers[cfg.branch].url,
      healthy: cfg.healthy ?? true,
      consecutiveFailures: 0,
    });
  }
}

afterEach(async () => {
  await Promise.all(
    Object.values(peers).map(
      (p) =>
        new Promise((r) => {
          p.server.closeAllConnections();
          p.server.close(r);
        })
    )
  );
  for (const k of Object.keys(peers)) delete peers[k];
  jest.resetAllMocks();
});

describe("getAllEntriesByBranch (from oshawa)", () => {
  test("local branch (oshawa) -> queries DB directly without calling peers", async () => {
    Library.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(SAMPLE_BOOKS.oshawa) });
    await setPeers([
      { branch: "ajax", books: SAMPLE_BOOKS.ajax, lamport: 5 },
      { branch: "whitby", books: SAMPLE_BOOKS.whitby, lamport: 8 },
    ]);

    const result = await getAllEntriesByBranch("oshawa");

    expect(result.source).toBe("local");
    expect(result.branch).toBe("oshawa");
    expect(result.books).toEqual(SAMPLE_BOOKS.oshawa);
    expect(Library.find).toHaveBeenCalledWith({ currentBranch: "oshawa" });
    expect(peers.ajax.received).toHaveLength(0);
    expect(peers.whitby.received).toHaveLength(0);
  });

  test("remote branch (ajax) -> fetches from peer /internal/books and advances Lamport clock", async () => {
    await setPeers([
      { branch: "ajax", books: SAMPLE_BOOKS.ajax, lamport: 75 },
      { branch: "whitby", books: SAMPLE_BOOKS.whitby, lamport: 12 },
    ]);

    const result = await getAllEntriesByBranch("ajax");

    expect(peers.ajax.received).toHaveLength(1);
    expect(peers.ajax.received[0].url).toBe("/internal/books");
    expect(peers.ajax.received[0].headers["x-internal-secret"]).toBe("test-internal-secret");
    expect(Number(peers.ajax.received[0].headers["x-lamport-timestamp"])).toBeGreaterThan(0);

    expect(peers.whitby.received).toHaveLength(0);
    expect(result.source).toBe("peer");
    expect(result.branch).toBe("ajax");
    expect(result.books).toEqual(SAMPLE_BOOKS.ajax);
    expect(lamportClock.now()).toBeGreaterThan(75);
  });

  test("unhealthy peer -> fails fast with 503 without making HTTP call", async () => {
    await setPeers([{ branch: "ajax", books: SAMPLE_BOOKS.ajax, healthy: false }]);

    await expect(getAllEntriesByBranch("ajax")).rejects.toMatchObject({ statusCode: 503 });
    expect(peers.ajax.received).toHaveLength(0);
  });

  test("hanging peer -> times out and throws 503", async () => {
    await setPeers([{ branch: "whitby", hang: true }]);

    await expect(getAllEntriesByBranch("whitby")).rejects.toMatchObject({
      statusCode: 503,
    });
  });


  test("invalid branch -> throws 400", async () => {
    await expect(getAllEntriesByBranch("toronto")).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("public route GET /api/circulation/branches/:branch/books", () => {
  const makeToken = () =>
    signToken({
      _id: "507f1f77bcf86cd799439011",
      role: "patron",
      homeBranch: "oshawa",
    });

  test("returns 401 when unauthenticated", async () => {
    const res = await request(app).get("/api/circulation/branches/oshawa/books");
    expect(res.status).toBe(401);
  });

  test("returns 200 with branch, source, count, and books when authenticated", async () => {
    Library.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(SAMPLE_BOOKS.oshawa) });

    const res = await request(app)
      .get("/api/circulation/branches/oshawa/books")
      .set("Authorization", `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      branch: "oshawa",
      source: "local",
      count: 2,
      books: SAMPLE_BOOKS.oshawa,
    });
  });

  test("returns 400 for an invalid branch name", async () => {
    const res = await request(app)
      .get("/api/circulation/branches/markham/books")
      .set("Authorization", `Bearer ${makeToken()}`);

    expect(res.status).toBe(400);
  });
});

describe("answering branch (GET /internal/books)", () => {
  const ask = (headers = {}) =>
    request(app).get("/internal/books").set({ "x-internal-secret": "test-internal-secret", ...headers });

  test("returns 200 with all copies at this branch and syncs Lamport clock", async () => {
    Library.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(SAMPLE_BOOKS.oshawa) });

    const res = await ask({ "x-lamport-timestamp": "1000" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ branch: "oshawa", books: SAMPLE_BOOKS.oshawa });
    expect(Number(res.headers["x-lamport-timestamp"])).toBeGreaterThan(1000);
    expect(Library.find).toHaveBeenCalledWith({ currentBranch: "oshawa" });
  });

  test("rejects callers without the internal secret", async () => {
    const res = await request(app).get("/internal/books");
    expect(res.status).toBe(403);
    expect(Library.find).not.toHaveBeenCalled();
  });
});
