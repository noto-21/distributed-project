// Refresh tokens + logout, and duplicate-email repair, against a REAL MongoDB (npm run test:db).
// This process is OSHAWA; "ajax" is a fake peer. Touches only users "test-acc-*@test.local" and their tokens.
process.env.BRANCH_ID = "oshawa";
process.env.INTERNAL_API_SECRET = "test-internal-secret";
process.env.PEER_TIMEOUT_MS = "800";
process.env.AUTH_RATE_LIMIT = "1000";
process.env.JWT_EXPIRES_IN = "15m"; // the developer .env may say 1h; dotenv never overrides a set var

const http = require("node:http");
const mongoose = require("mongoose");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const env = require("../src/config/env");
const app = require("../src/server");
const User = require("../src/models/User");
const RefreshToken = require("../src/models/RefreshToken");
const discoveryService = require("../src/services/discoveryService");
const userService = require("../src/services/userService");

jest.setTimeout(30000);

const EMAIL = /^test-acc-.*@test\.local$/;
let ajax; // { server, behave, seen }

async function cleanup() {
  const users = await User.find({ email: EMAIL }, { _id: 1 }).lean();
  await RefreshToken.deleteMany({ userId: { $in: users.map((u) => String(u._id)) } });
  await User.deleteMany({ email: EMAIL });
}

async function makeUser(email, over = {}) {
  return User.create({ email, passwordHash: await bcrypt.hash("password123", 4), homeBranch: "oshawa", ...over });
}

const login = (email) => request(app).post("/api/auth/login").send({ email, password: "password123" });
const refresh = (refreshToken) => request(app).post("/api/auth/refresh").send({ refreshToken });

beforeAll(async () => {
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000, runtimeAdapters: { os: require("node:os") } });
  ajax = { seen: [], behave: () => [404, {}] };
  ajax.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      ajax.seen.push({ url: req.url, body });
      const [status, json] = ajax.behave(req, body);
      res.writeHead(status, { "Content-Type": "application/json", "x-lamport-timestamp": "7" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => ajax.server.listen(0, "127.0.0.1", r));
  await cleanup();
});

beforeEach(() => {
  ajax.seen = [];
  ajax.behave = () => [404, {}];
  discoveryService.peers.clear();
  discoveryService.peers.set("ajax", { branch: "ajax", url: `http://127.0.0.1:${ajax.server.address().port}`, healthy: true, consecutiveFailures: 0 });
});

afterEach(cleanup);

afterAll(async () => {
  await mongoose.connection.close();
  ajax.server.closeAllConnections();
  await new Promise((r) => ajax.server.close(r));
});

describe("refresh tokens", () => {
  test("login returns a short access token plus a refresh token stored (hashed) at the home branch", async () => {
    await makeUser("test-acc-1@test.local");
    const res = await login("test-acc-1@test.local");

    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toMatch(/^oshawa\./);
    const { exp, iat } = jwt.verify(res.body.token, env.jwtSecret);
    expect(exp - iat).toBe(15 * 60);
    const stored = await RefreshToken.findOne({ userId: String(res.body.user._id) }).lean();
    expect(stored.tokenHash).not.toContain(res.body.refreshToken.split(".")[1]); // never stored in clear
  });

  test("refresh rotates: new pair works, the old refresh token is spent", async () => {
    await makeUser("test-acc-2@test.local");
    const first = (await login("test-acc-2@test.local")).body;

    const second = await refresh(first.refreshToken);
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);
    expect(jwt.verify(second.body.token, env.jwtSecret).userId).toBe(String(first.user._id));
    expect((await refresh(second.body.refreshToken)).status).toBe(200);
  });

  test("reusing a spent refresh token (stolen copy) signs the user out everywhere", async () => {
    await makeUser("test-acc-3@test.local");
    const first = (await login("test-acc-3@test.local")).body;
    const second = (await refresh(first.refreshToken)).body;

    const replay = await refresh(first.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("REFRESH_TOKEN_REUSED");
    expect((await refresh(second.refreshToken)).status).toBe(401); // the legit session is gone too
  });

  test("two refreshes racing on one token: exactly one rotates", async () => {
    await makeUser("test-acc-4@test.local");
    const { refreshToken } = (await login("test-acc-4@test.local")).body;
    const results = await Promise.all([refresh(refreshToken), refresh(refreshToken)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  test("logout revokes the refresh token; logging out again is harmless", async () => {
    await makeUser("test-acc-5@test.local");
    const { refreshToken } = (await login("test-acc-5@test.local")).body;

    expect((await request(app).post("/api/auth/logout").send({ refreshToken })).status).toBe(204);
    const after = await refresh(refreshToken);
    expect(after.status).toBe(401);
    expect((await request(app).post("/api/auth/logout").send({ refreshToken })).status).toBe(204);
  });

  test("a refresh token from another home branch is forwarded there", async () => {
    ajax.behave = (req) => (req.url === "/internal/auth/refresh"
      ? [200, { token: "access-from-ajax", refreshToken: "ajax.rotated", homeBranch: "ajax" }]
      : [404, {}]);

    const res = await refresh("ajax.some-token");

    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBe("ajax.rotated");
    expect(ajax.seen[0]).toMatchObject({ url: "/internal/auth/refresh", body: { refreshToken: "ajax.some-token" } });
  });

  test("garbage refresh tokens are rejected", async () => {
    expect((await refresh("not-a-token")).status).toBe(401);
    expect((await refresh(undefined)).status).toBe(401);
  });
});

describe("duplicate-email repair", () => {
  test("ajax created the same email earlier (Lamport) -> oshawa's copy is flagged and stops being used", async () => {
    await makeUser("test-acc-dup1@test.local", { createdLamport: 50 });
    ajax.behave = (req, body) => {
      if (req.url === "/internal/users/lookup") return [200, { users: body.emails.includes("test-acc-dup1@test.local") ? [{ email: "test-acc-dup1@test.local", createdLamport: 10 }] : [] }];
      if (req.url === "/internal/users/verify") return [200, { user: { _id: "a1", email: body.email, role: "patron", homeBranch: "ajax" }, refreshToken: "ajax.rt" }];
      return [404, {}];
    };

    const report = await userService.reconcileDuplicates();

    expect(report.flagged).toEqual([{ email: "test-acc-dup1@test.local", keptAt: "ajax" }]);
    expect((await User.findOne({ email: "test-acc-dup1@test.local" })).duplicateOf).toBe("ajax");
    const res = await login("test-acc-dup1@test.local"); // now resolved at ajax, the surviving account
    expect(res.body.homeBranch).toBe("ajax");
  });

  test("oshawa created it first -> oshawa keeps it (ajax flags its own copy on its side)", async () => {
    await makeUser("test-acc-dup2@test.local", { createdLamport: 5 });
    ajax.behave = () => [200, { users: [{ email: "test-acc-dup2@test.local", createdLamport: 99 }] }];

    expect((await userService.reconcileDuplicates()).flagged).toEqual([]);
    expect((await User.findOne({ email: "test-acc-dup2@test.local" })).duplicateOf).toBeNull();
  });

  test("same Lamport time -> branch name breaks the tie identically everywhere (ajax < oshawa)", async () => {
    await makeUser("test-acc-dup3@test.local", { createdLamport: 42 });
    ajax.behave = () => [200, { users: [{ email: "test-acc-dup3@test.local", createdLamport: 42 }] }];
    expect((await userService.reconcileDuplicates()).flagged).toEqual([{ email: "test-acc-dup3@test.local", keptAt: "ajax" }]);
  });

  test("peer offline -> nothing is flagged blind", async () => {
    await makeUser("test-acc-dup4@test.local", { createdLamport: 50 });
    discoveryService.peers.get("ajax").healthy = false;
    expect((await userService.reconcileDuplicates()).flagged).toEqual([]);
  });

  test("internal lookup only reports active accounts", async () => {
    await makeUser("test-acc-live@test.local", { createdLamport: 3 });
    await makeUser("test-acc-gone@test.local", { createdLamport: 4, duplicateOf: "whitby" });
    const res = await request(app).post("/internal/users/lookup").set("x-internal-secret", "test-internal-secret")
      .send({ emails: ["test-acc-live@test.local", "test-acc-gone@test.local"] });
    expect(res.body.users).toEqual([{ email: "test-acc-live@test.local", createdLamport: 3 }]);
  });
});
