// Browser-facing protections: CORS for the React app only, security headers, auth rate limits. DB-free.
process.env.BRANCH_ID = "oshawa";
process.env.MONGO_URI = "mongodb://localhost:27017/library_test";
process.env.CLIENT_URL = "http://localhost:5173";
process.env.AUTH_RATE_LIMIT = "3";

jest.mock("../src/models/User", () => ({ findOne: jest.fn(async () => null), exists: jest.fn(async () => null) }));

const request = require("supertest");
const app = require("../src/server");

describe("CORS", () => {
  test("the React dev server may call the API", async () => {
    const res = await request(app).get("/healthz").set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined(); // tokens are headers, not cookies
  });

  test("preflight allows Authorization + JSON for the app", async () => {
    const res = await request(app).options("/api/circulation/checkout")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-headers"]).toMatch(/Authorization/);
  });

  test("any other site gets no CORS permission", async () => {
    const res = await request(app).get("/healthz").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

test("security headers are set and Express is not advertised", async () => {
  const res = await request(app).get("/healthz");
  expect(res.headers).toMatchObject({
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  });
  expect(res.headers["x-powered-by"]).toBeUndefined();
});

describe("rate limits (AUTH_RATE_LIMIT=3 per 15 min per IP)", () => {
  const login = (ip) => request(app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ email: "a@b.ca", password: "wrong-password" });

  test("the 4th login attempt from one IP is refused with 429 and Retry-After", async () => {
    for (let i = 0; i < 3; i += 1) expect((await login("203.0.113.7")).status).toBe(401);
    const res = await login("203.0.113.7");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  test("another client is unaffected, and each endpoint has its own budget", async () => {
    expect((await login("198.51.100.9")).status).toBe(401);
    const reg = await request(app).post("/api/auth/register").set("X-Forwarded-For", "203.0.113.7").send({});
    expect(reg.status).toBe(400); // validation error, not 429: register's budget is separate
  });
});
