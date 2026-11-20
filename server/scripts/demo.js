#!/usr/bin/env node
// Live, narrated demo of the distributed library against the running Docker stack.
//   npm run demo                  run everything
//   npm run demo -- --step        pause for Enter between acts (presenting)
//   npm run demo -- --isbn 0002005883 --skip-failure --skip-recovery --rate-limit --keep
// Needs: docker compose up -d  (gateway on http://localhost:8090, or set GATEWAY_URL)
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);

const GATEWAY = process.env.GATEWAY_URL || "http://localhost:8090";
const ROOT = path.resolve(__dirname, "../..");
const ISBN = opt("isbn", "0002005883");
const HOME = "ajax";
const RUN = Date.now().toString(36);
const PATRON = { email: `demo-${RUN}@demo.local`, password: "demo-password-1", name: "Demo Patron" };
const RIVAL = { email: `demo-rival-${RUN}@demo.local`, password: "demo-password-2", name: "Rival Patron" };

// ---------- presentation helpers ----------
const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c("1"), dim = c("2"), green = c("32"), red = c("31"), yellow = c("33"), cyan = c("36");
const say = (s = "") => console.log(s);
const ok = (s) => say(`  ${green("✓")} ${s}`);
const bad = (s) => say(`  ${red("✗")} ${s}`);
const note = (s) => say(`    ${dim(s)}`);
const call = (method, url, status, ms) => say(`  ${cyan(method.padEnd(4))} ${url}  ${status >= 400 ? yellow(status) : green(status)} ${dim(`${ms}ms`)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let act = 0;
async function scene(title) {
  if (flag("step") && act > 0) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((r) => rl.question(dim("\n  [Enter] next act "), () => { rl.close(); r(); }));
  }
  act += 1;
  say(`\n${bold(`━━ Act ${act}: ${title} ━━`)}`);
}

async function api(method, branch, route, { body, token, quiet } = {}) {
  const url = `/${branch}${route}`;
  const t0 = Date.now();
  const res = await fetch(`${GATEWAY}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!quiet) call(method, url, res.status, Date.now() - t0);
  return { status: res.status, body: json, ms: Date.now() - t0 };
}

const compose = (...a) => execFileSync("docker", ["compose", ...a], { cwd: ROOT, stdio: "pipe" }).toString();
async function waitHealthy(branch, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if ((await api("GET", branch, "/healthz", { quiet: true })).status === 200) return true; } catch { /* starting */ }
    await sleep(1500);
  }
  return false;
}
const trail = (book) => (book?.custodyHistory || []).map((e) => `${e.event}@${e.branch} L${e.lamport}`).join("  →  ") || "(no history yet)";

// ---------- the demo ----------
async function main() {
  say(bold("Distributed Public Library — live demo"));
  note(`gateway ${GATEWAY}   patron home branch: ${HOME}   book: ${ISBN}`);

  await scene("Three autonomous branches behind one gateway");
  for (const b of ["ajax", "oshawa", "whitby"]) {
    const r = await api("GET", b, "/healthz").catch(() => ({ status: 0 }));
    if (r.status !== 200) throw new Error(`${b} is not ready. Start the stack: docker compose up -d`);
    ok(`${b}: DB ${r.body.status}, answered by replica ${r.body.instance}`);
  }
  note("Each branch has its own Atlas cluster and 2 app replicas; NGINX load-balances /<branch>/*.");

  await scene("Sign up at OSHAWA, choosing AJAX as home branch");
  let r = await api("POST", "oshawa", "/api/auth/register", { body: { ...PATRON, homeBranch: HOME } });
  ok(`account created at ${bold(r.body.homeBranch)} (request handled by oshawa, forwarded with only a bcrypt hash)`);
  note(`refresh token lives at its home branch: ${r.body.refreshToken.split(".")[0]}.…`);
  r = await api("POST", "whitby", "/api/auth/register", { body: { ...PATRON, homeBranch: "whitby" } });
  r.status === 409 ? ok(`same email at whitby refused: ${r.body.code} (branches check each other)`) : bad(`expected 409, got ${r.status}`);

  await scene("Log in at WHITBY — the account lives at ajax");
  r = await api("POST", "whitby", "/api/auth/login", { body: { email: PATRON.email, password: PATRON.password } });
  let { token, refreshToken } = r.body;
  ok(`whitby asked its peers; ajax verified the password -> homeBranch ${bold(r.body.homeBranch)}`);
  r = await api("GET", "oshawa", "/api/auth/me", { token });
  ok(`/me through oshawa is read from ajax: ${r.body.user?.email}`);

  await scene(`Federated search for ${ISBN}`);
  r = await api("GET", HOME, `/api/circulation/books/${ISBN}`);
  const holder = r.body.foundAt?.[0]?.branch;
  if (!holder) throw new Error(`No branch has ${ISBN} available. Pick another with --isbn`);
  ok(`${r.body.source === "local" ? "on the shelf at ajax" : `not at ajax; peers asked in parallel -> found at ${bold(holder)}`}`);
  note(`"${r.body.foundAt[0].book.title}"`);

  await scene("Request it to my home branch (inter-library transfer saga)");
  r = await api("POST", HOME, "/api/circulation/requests", { token, body: { isbn10: ISBN } });
  if (r.body.status === "TRANSFERRED") ok(`${r.body.from} -> ${r.body.to}: locked, sent, committed, deleted at source (saga ${r.body.transfer?.sagaId?.slice(0, 8)}…)`);
  else ok(`status ${r.body.status} at ${r.body.branch}`);
  ok(`ON HOLD for me until ${new Date(r.body.holdExpiresAt).toLocaleString()}`);

  await scene("Someone else can't take my hold");
  await api("POST", "oshawa", "/api/auth/register", { body: { ...RIVAL, homeBranch: HOME }, quiet: true });
  const rival = (await api("POST", HOME, "/api/auth/login", { body: { email: RIVAL.email, password: RIVAL.password }, quiet: true })).body.token;
  r = await api("POST", HOME, "/api/circulation/checkout", { token: rival, body: { isbn10: ISBN } });
  r.status === 409 ? ok(`rival refused: ${r.body.code}`) : bad(`expected 409, got ${r.status}`);

  await scene("Check out, then return — the copy routes itself home");
  r = await api("POST", HOME, "/api/circulation/checkout", { token, body: { isbn10: ISBN } });
  ok(`checked out, due ${new Date(r.body.loan.dueAt).toLocaleDateString()} (Lamport L${r.body.loan.checkoutLamport})`);
  r = await api("GET", HOME, "/api/circulation/loans/me", { token });
  ok(`my loans: ${r.body.loans.map((l) => `${l.isbn10} ${l.status}${l.overdue ? " OVERDUE" : ""}`).join(", ")}`);
  r = await api("POST", HOME, "/api/circulation/return", { token, body: { isbn10: ISBN } });
  ok(`${r.body.message}${r.body.late ? " (late)" : ""}`);

  await scene("Custody trail, ordered by Lamport time (wall clocks differ per branch)");
  r = await api("GET", "oshawa", `/api/circulation/books/${ISBN}`);
  const copy = r.body.foundAt?.[0];
  ok(`now at ${bold(copy?.branch)}`);
  say(`    ${trail(copy?.book)}`);
  const l = (copy?.book?.custodyHistory || []).map((e) => e.lamport);
  l.every((v, i) => i === 0 || v > l[i - 1]) ? ok("strictly increasing Lamport timestamps") : bad("Lamport order broken");

  await scene("Sessions: rotating refresh tokens, reuse detection, logout");
  r = await api("POST", "oshawa", "/api/auth/refresh", { body: { refreshToken } });
  ok(`refreshed via oshawa (forwarded to ajax, where the token is stored); access token valid 15 min`);
  const stolen = refreshToken;
  ({ token, refreshToken } = r.body);
  r = await api("POST", HOME, "/api/auth/refresh", { body: { refreshToken: stolen } });
  r.status === 401 ? ok(`replaying the old token -> ${r.body.code}: every session of this user is revoked`) : bad(`expected 401, got ${r.status}`);
  r = await api("POST", HOME, "/api/auth/logout", { body: { refreshToken } });
  ok(`logout -> ${r.status}`);

  if (!flag("skip-failure")) {
    await scene("Failure: WHITBY goes down mid-service");
    compose("stop", "branch-whitby");
    ok("docker compose stop branch-whitby");
    const probe = "000649689X"; // a copy that lives at ajax
    r = await api("GET", "oshawa", `/api/circulation/books/${probe}`);
    ok(`search still answers: found at ${r.body.foundAt?.map((f) => f.branch).join(", ") || "nowhere"}, offline ${JSON.stringify(r.body.offline)}`);
    note(`warning: ${r.body.warning}  (${r.ms}ms: waited out whitby's timeout)`);
    note("waiting ~16s for heartbeats to mark whitby down...");
    await sleep(16_000);
    r = await api("GET", "oshawa", `/api/circulation/books/${probe}`);
    ok(`same search now ${r.ms}ms: whitby skipped, still reported offline`);
    compose("start", "branch-whitby");
    ok("docker compose start branch-whitby");
    (await waitHealthy("whitby")) ? ok("whitby healthy again (it retried its DB connection by itself)") : bad("whitby not healthy after 60s");
  }

  if (!flag("skip-recovery")) {
    await scene("Crash recovery: every way a transfer can be interrupted");
    note("Runs the failure-demo tests against a real MongoDB (oshawa's cluster from .env, TEST-* rows only).");
    // Jest's per-test lines only appear on a terminal, so read its JSON report instead. No shell involved.
    const res = spawnSync(process.execPath, [require.resolve("jest/bin/jest"), "--runInBand", "--forceExit", "--json",
      "--testMatch", "**/tests/circulation.db.js", "-t", "failure demo"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
    let results = [];
    try { results = JSON.parse(res.stdout).testResults.flatMap((t) => t.assertionResults); } catch { /* reported below */ }
    const ran = results.filter((t) => t.status !== "pending");
    if (!ran.length) bad("could not run the recovery tests (is MONGO_URI_OSHAWA in .env?)");
    ran.forEach((t) => (t.status === "passed" ? ok(t.title) : bad(t.title)));
  }

  if (flag("rate-limit")) {
    await scene("Brute force protection");
    let n = 0;
    for (; n < 40; n += 1) {
      const t = await api("POST", HOME, "/api/auth/login", { body: { email: PATRON.email, password: "wrong" }, quiet: true });
      if (t.status === 429) break;
    }
    ok(`blocked with 429 after ${n} wrong passwords from this IP (limit per replica; 15-minute window)`);
    note("Note: logins from this machine stay blocked at ajax for 15 minutes.");
  }

  if (!flag("keep")) {
    await scene("Cleanup");
    const js = `const m=require('mongoose');m.connect(process.env.MONGO_URI).then(async()=>{const db=m.connection.db;`
      + `const us=await db.collection('users').find({email:{$in:${JSON.stringify([PATRON.email, RIVAL.email])}}}).toArray();const ids=us.map(u=>String(u._id));`
      + `await db.collection('loans').deleteMany({userId:{$in:ids}});await db.collection('refreshtokens').deleteMany({userId:{$in:ids}});`
      + `const d=await db.collection('users').deleteMany({_id:{$in:us.map(u=>u._id)}});console.log(d.deletedCount);process.exit(0)})`;
    const n = compose("exec", "-T", HOME === "ajax" ? "branch-ajax" : `branch-${HOME}`, "node", "-e", js).trim();
    ok(`removed ${n} demo accounts with their loans and refresh tokens (the book's custody trail is kept)`);
  }

  say(`\n${green(bold("Demo complete."))}`);
}

main().catch((err) => {
  say(`\n${red(bold("Demo stopped:"))} ${err.message}`);
  process.exit(1);
});
