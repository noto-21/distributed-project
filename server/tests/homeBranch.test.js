// Users live only at their home branch. Signup at ANY branch lands the account at the branch the user picked,
// login at any branch finds it, and /me reads it from home. DB-free: User is mocked, "ajax" is a fake peer.
process.env.BRANCH_ID = "oshawa";
process.env.MONGO_URI = "mongodb://localhost:27017/library_test";
process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.PEER_TIMEOUT_MS = "300";

jest.mock("../src/models/User", () => ({ create: jest.fn(), findOne: jest.fn(), findById: jest.fn(), exists: jest.fn() }));
jest.mock("../src/models/RefreshToken", () => ({ create: jest.fn(async () => ({})), findOneAndUpdate: jest.fn(), findOne: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn() }));


const http = require("node:http");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const app = require("../src/server");
const User = require("../src/models/User");
const env = require("../src/config/env");
const discoveryService = require("../src/services/discoveryService");
const { signToken } = require("../src/middlewares/auth");

const AJAX_USER = { _id: "a1", email: "amy@ajax.ca", role: "patron", homeBranch: "ajax" };
let ajax; // fake ajax branch
let seen; // requests ajax received

beforeAll(async () => {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ method: req.method, url: req.url, body, headers: req.headers });
      const send = (status, json) => { res.writeHead(status, { "Content-Type": "application/json", "x-lamport-timestamp": "40" }); res.end(JSON.stringify(json)); };
      if (req.url.startsWith("/internal/users/exists")) return send(200, { exists: req.url.includes(encodeURIComponent("amy@ajax.ca")) });
      if (req.url === "/internal/users" && req.method === "POST") return send(201, { user: { _id: "a2", email: body.email, role: "patron", homeBranch: "ajax" }, refreshToken: "ajax.rt-new" });
      if (req.url === "/internal/users/verify") {
        if (body.email !== "amy@ajax.ca") return send(404, { found: false });
        return body.password === "password123" ? send(200, { user: AJAX_USER, refreshToken: "ajax.rt-login" }) : send(401, { code: "INVALID_CREDENTIALS" });
      }
      if (req.url === "/internal/users/a1") return send(200, { user: AJAX_USER });
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  ajax = { server, url: `http://127.0.0.1:${server.address().port}` };
});

afterAll(() => new Promise((r) => { ajax.server.closeAllConnections(); ajax.server.close(r); }));

beforeEach(() => {
  seen = [];
  jest.resetAllMocks();
  require("../src/models/RefreshToken").create.mockResolvedValue({});
  User.exists.mockResolvedValue(null);
  User.findOne.mockResolvedValue(null); // nobody is registered at oshawa
  discoveryService.peers.clear();
  discoveryService.peers.set("ajax", { branch: "ajax", url: ajax.url, healthy: true, consecutiveFailures: 0 });
});

const register = (body) => request(app).post("/api/auth/register").send({ password: "password123", ...body });

describe("signup picks the home branch", () => {
  test("choosing this branch creates the account here, after checking no other branch has the email", async () => {
    User.create.mockImplementation(async (doc) => ({ _id: "o1", role: "patron", ...doc }));
    const res = await register({ email: "New@Osh.ca", homeBranch: "oshawa" });

    expect(res.status).toBe(201);
    expect(res.body.homeBranch).toBe("oshawa");
    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({ email: "new@osh.ca", homeBranch: "oshawa" }));
    expect(seen.map((r) => r.url)).toEqual([`/internal/users/exists?email=${encodeURIComponent("new@osh.ca")}`]);
  });

  test("choosing another branch forwards the account there; only a bcrypt hash crosses, never the password", async () => {
    const res = await register({ email: "bob@ajax.ca", name: "Bob", homeBranch: "ajax" });

    expect(res.status).toBe(201);
    expect(User.create).not.toHaveBeenCalled(); // nothing stored at oshawa
    const forwarded = seen.find((r) => r.url === "/internal/users");
    expect(forwarded.headers["x-internal-secret"]).toBe("test-internal-secret");
    expect(forwarded.body.password).toBeUndefined();
    expect(await bcrypt.compare("password123", forwarded.body.passwordHash)).toBe(true);
    expect(jwt.verify(res.body.token, env.jwtSecret)).toMatchObject({ userId: "a2", homeBranch: "ajax" });
    expect(res.body.homeBranch).toBe("ajax"); // client switches to /ajax/ from here on
    expect(res.body.refreshToken).toBe("ajax.rt-new"); // minted and stored by the home branch
  });

  test("an email already registered at another branch is refused", async () => {
    const res = await register({ email: "amy@ajax.ca", homeBranch: "oshawa" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMAIL_TAKEN");
    expect(User.create).not.toHaveBeenCalled();
  });

  test("home branch offline -> clear 503, nothing created anywhere", async () => {
    discoveryService.peers.get("ajax").healthy = false;
    const res = await register({ email: "bob@ajax.ca", homeBranch: "ajax" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("HOME_BRANCH_OFFLINE");
    expect(seen).toHaveLength(0);
  });
});

describe("login works at any branch", () => {
  test("user not here -> peers asked; the home branch verifies and the token names it", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "amy@ajax.ca", password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.homeBranch).toBe("ajax");
    expect(jwt.verify(res.body.token, env.jwtSecret)).toMatchObject({ userId: "a1", homeBranch: "ajax" });
  });

  test("wrong password at the home branch -> 401", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "amy@ajax.ca", password: "nope-nope" });
    expect(res.status).toBe(401);
  });

  test("user exists here with a wrong password -> 401 without asking peers", async () => {
    User.findOne.mockResolvedValue({ _id: "o1", email: "o@osh.ca", homeBranch: "oshawa", passwordHash: await bcrypt.hash("right-pass", 4) });
    const res = await request(app).post("/api/auth/login").send({ email: "o@osh.ca", password: "wrong-pass" });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("/me for a user whose home is elsewhere is read from the home branch", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${signToken(AJAX_USER)}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("amy@ajax.ca");
    expect(User.findById).not.toHaveBeenCalled();
  });
});

describe("internal user endpoints (this branch answering a peer)", () => {
  const internal = (method, path) => request(app)[method](`/internal${path}`).set("x-internal-secret", "test-internal-secret");

  test("create requires a bcrypt hash, so a peer can't plant a plain-text password", async () => {
    expect((await internal("post", "/users").send({ email: "x@y.ca", passwordHash: "plaintext" })).status).toBe(400);
    User.create.mockImplementation(async (doc) => ({ _id: "o9", ...doc }));
    const res = await internal("post", "/users").send({ email: "x@y.ca", passwordHash: await bcrypt.hash("p", 4) });
    expect(res.status).toBe(201);
    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({ homeBranch: "oshawa" }));
  });

  test("verify: 404 unknown, 401 wrong password, 200 match", async () => {
    expect((await internal("post", "/users/verify").send({ email: "z@z.ca", password: "p" })).status).toBe(404);
    User.findOne.mockResolvedValue({ _id: "o1", email: "o@osh.ca", homeBranch: "oshawa", passwordHash: await bcrypt.hash("right-pass", 4) });
    expect((await internal("post", "/users/verify").send({ email: "o@osh.ca", password: "bad" })).status).toBe(401);
    expect((await internal("post", "/users/verify").send({ email: "o@osh.ca", password: "right-pass" })).status).toBe(200);
  });

  test("exists and get", async () => {
    User.exists.mockResolvedValue({ _id: "o1" });
    expect((await internal("get", "/users/exists?email=O@osh.ca")).body).toEqual({ exists: true });
    expect(User.exists).toHaveBeenCalledWith({ email: "o@osh.ca", duplicateOf: null }); // flagged duplicates don't count
    User.findById.mockResolvedValue(null);
    expect((await internal("get", "/users/nope")).status).toBe(404);
  });

  test("all of it is refused without the internal secret", async () => {
    expect((await request(app).post("/internal/users/verify").send({ email: "a", password: "b" })).status).toBe(403);
  });
});
