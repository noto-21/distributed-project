// Every signed-in request runs at the user's home branch, whichever branch NGINX handed it to.
// This process is WHITBY. "oshawa" is a fake home branch on a local port. DB-free: models are mocked.
process.env.BRANCH_ID = "whitby";
process.env.MONGO_URI = "mongodb://localhost:27017/library_test";
process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.PEER_TIMEOUT_MS = "300";
process.env.FORWARD_TIMEOUT_MS = "400";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";

jest.mock("../src/models/User", () => ({ findOne: jest.fn(), findById: jest.fn(), exists: jest.fn() }));
jest.mock("../src/models/Library", () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock("../src/models/Loan", () => ({ find: jest.fn() }));

const http = require("node:http");
const request = require("supertest");
const app = require("../src/server");
const Library = require("../src/models/Library");
const Loan = require("../src/models/Loan");
const User = require("../src/models/User");
const discoveryService = require("../src/services/discoveryService");
const { signToken } = require("../src/middlewares/auth");

const OSHAWA_PATRON = { _id: "o1", role: "patron", homeBranch: "oshawa" };
const WHITBY_PATRON = { _id: "w1", role: "patron", homeBranch: "whitby" };
const bearer = (u) => `Bearer ${signToken(u)}`;

let oshawa; // { server, url, seen, behave }

beforeAll(async () => {
  oshawa = { seen: [], behave: () => [200, { ok: true }] };
  oshawa.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      oshawa.seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const out = await oshawa.behave(req);
      if (!out) return; // hang
      res.writeHead(out[0], { "Content-Type": "application/json", "x-lamport-timestamp": "70" });
      res.end(JSON.stringify(out[1]));
    });
  });
  await new Promise((r) => oshawa.server.listen(0, "127.0.0.1", r));
  oshawa.url = `http://127.0.0.1:${oshawa.server.address().port}`;
});

afterAll(() => new Promise((r) => { oshawa.server.closeAllConnections(); oshawa.server.close(r); }));

beforeEach(() => {
  oshawa.seen = [];
  oshawa.behave = () => [200, { ok: true }];
  jest.resetAllMocks();
  discoveryService.peers.clear();
  discoveryService.peers.set("oshawa", { branch: "oshawa", url: oshawa.url, healthy: true, consecutiveFailures: 0 });
});

describe("signed-in requests are forwarded to the home branch", () => {
  test("a request for a book arriving at whitby runs at oshawa, and the patron gets oshawa's answer", async () => {
    oshawa.behave = () => [200, { status: "TRANSFERRED", message: "Ajax is sending “Dune” to your branch (Oshawa)." }];
    const token = bearer(OSHAWA_PATRON);

    const res = await request(app).post("/api/circulation/requests").set("Authorization", token).send({ isbn10: "0441013597" });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/sending “Dune” to your branch \(Oshawa\)/);
    expect(res.headers["x-served-by-branch"]).toBe("oshawa");
    expect(oshawa.seen).toEqual([expect.objectContaining({
      method: "POST",
      url: "/api/circulation/requests",
      body: { isbn10: "0441013597" },
      headers: expect.objectContaining({ authorization: token, "x-forwarded-by-branch": "whitby" }),
    })]);
    expect(Library.findOne).not.toHaveBeenCalled(); // nothing ran at whitby
  });

  test.each([
    ["post", "/api/circulation/checkout"],
    ["post", "/api/circulation/return"],
    ["get", "/api/circulation/loans/me"],
    ["get", "/api/circulation/holds/me"],
    ["get", "/api/auth/me"],
  ])("%s %s is forwarded too", async (method, path) => {
    await request(app)[method](path).set("Authorization", bearer(OSHAWA_PATRON)).send(method === "post" ? { isbn10: "x" } : undefined);
    expect(oshawa.seen.map((r) => r.url)).toEqual([path]);
  });

  test("errors from the home branch reach the patron unchanged", async () => {
    oshawa.behave = () => [409, { error: "You don't have it checked out", code: "NOT_BORROWED_BY_YOU" }];
    const res = await request(app).post("/api/circulation/return").set("Authorization", bearer(OSHAWA_PATRON)).send({ isbn10: "x" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_BORROWED_BY_YOU");
  });

  test("librarians also act at their own branch", async () => {
    const librarian = { _id: "l1", role: "librarian", homeBranch: "oshawa" };
    await request(app).get("/api/circulation/loans/overdue").set("Authorization", bearer(librarian));
    expect(oshawa.seen.map((r) => r.url)).toEqual(["/api/circulation/loans/overdue"]);
  });

  test("home branch marked offline -> 503 HOME_BRANCH_OFFLINE without trying", async () => {
    discoveryService.peers.get("oshawa").healthy = false;
    const res = await request(app).get("/api/circulation/loans/me").set("Authorization", bearer(OSHAWA_PATRON));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "HOME_BRANCH_OFFLINE", error: expect.stringMatching(/Oshawa/) });
    expect(oshawa.seen).toHaveLength(0);
  });

  test("home branch hangs -> 503 after the forward timeout, nothing done here", async () => {
    oshawa.behave = () => null;
    const res = await request(app).post("/api/circulation/checkout").set("Authorization", bearer(OSHAWA_PATRON)).send({ isbn10: "x" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("HOME_BRANCH_OFFLINE");
  });
});

describe("requests at the home branch are handled locally", () => {
  test("a whitby patron's loans are read right here", async () => {
    Loan.find.mockReturnValue({ sort: () => ({ lean: async () => [] }) });
    const res = await request(app).get("/api/circulation/loans/me").set("Authorization", bearer(WHITBY_PATRON));
    expect(res.status).toBe(200);
    expect(res.headers["x-served-by-branch"]).toBeUndefined();
    expect(oshawa.seen).toHaveLength(0);
  });

  test("signed-out search runs wherever it lands; signed-in search starts at the home branch", async () => {
    Library.findOne.mockResolvedValue(null);
    discoveryService.peers.clear(); // no peers to fan out to: keeps the anonymous case local-only
    expect((await request(app).get("/api/circulation/books/x")).status).toBe(404);

    discoveryService.peers.set("oshawa", { branch: "oshawa", url: oshawa.url, healthy: true, consecutiveFailures: 0 });
    oshawa.behave = () => [200, { source: "local", foundAt: [{ branch: "oshawa" }] }];
    const res = await request(app).get("/api/circulation/books/x").set("Authorization", bearer(OSHAWA_PATRON));
    expect(res.body.source).toBe("local");
    expect(oshawa.seen.map((r) => r.url)).toEqual(["/api/circulation/books/x"]);
  });
});

describe("sign-in", () => {
  const login = () => request(app).post("/api/auth/login").send({ email: "o@osh.ca", password: "password123" });

  test("account's branch unreachable -> 503 (not a misleading 'wrong password')", async () => {
    User.findOne.mockResolvedValue(null);
    discoveryService.peers.get("oshawa").healthy = false;
    const res = await login();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("HOME_BRANCH_OFFLINE");
  });

  test("every branch answered and none has the account -> 401", async () => {
    User.findOne.mockResolvedValue(null);
    oshawa.behave = () => [404, { found: false }];
    expect((await login()).status).toBe(401);
  });

  test("Google sign-up through /api picks the home branch: hands off to that branch's flow", async () => {
    const res = await request(app).get("/api/auth/google?homeBranch=oshawa");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/oshawa/api/auth/google");
    const here = await request(app).get("/api/auth/google?homeBranch=whitby");
    expect(new URL(here.headers.location).host).toBe("accounts.google.com");
  });
});
