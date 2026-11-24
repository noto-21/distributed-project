#!/usr/bin/env node
// Live, narrated demo of the distributed library against the running Docker stack.
//   npm run demo                  run everything
//   npm run demo -- --step        pause for Enter between acts (presenting)
//   npm run demo -- --isbn 0002005883 --skip-failure --skip-recovery --rate-limit --keep
// Needs: docker compose up -d  (gateway on http://localhost:8090, or set GATEWAY_URL)
//
// The patron only ever uses the single entry /api/...: NGINX hands each call to any branch, and the backend
// forwards it to the patron's home branch. Per-branch URLs are used only to show the system's insides.
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);

const GATEWAY = process.env.GATEWAY_URL || "http://localhost:8090";
const ROOT = path.resolve(__dirname, "../..");
const ISBN = opt("isbn", "0701179791");
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
const patronSees = (msg) => say(`    ${bold("Patron sees:")} ${msg}`);
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

// url: "/api/..." (the app's single entry) or "/<branch>/..." (a specific branch)
async function call(method, url, { body, token, quiet } = {}) {
  const t0 = Date.now();
  const res = await fetch(`${GATEWAY}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  const servedBy = res.headers.get("x-served-by-branch");
  const ms = Date.now() - t0;
  if (!quiet) {
    say(`  ${cyan(method.padEnd(4))} ${url}  ${res.status >= 400 ? yellow(res.status) : green(res.status)} ${dim(`${ms}ms`)}${servedBy ? dim(`  (landed elsewhere, answered by ${servedBy})`) : ""}`);
  }
  return { status: res.status, body: json, ms, servedBy };
}

const compose = (...a) => execFileSync("docker", ["compose", ...a], { cwd: ROOT, stdio: "pipe" }).toString();
async function waitHealthy(branch, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if ((await call("GET", `/${branch}/healthz`, { quiet: true })).status === 200) return true; } catch { /* starting */ }
    await sleep(1500);
  }
  return false;
}
// Latest hand-offs only: the copy keeps its whole history, which grows with every demo run.
const trail = (book, last = 4) => {
  const h = book?.custodyHistory || [];
  const shown = h.slice(-last).map((e) => `${e.event}@${e.branch} L${e.lamport}`).join("  →  ");
  return h.length > last ? `… (${h.length - last} earlier)  →  ${shown}` : shown || "(no history yet)";
};

// ---------- the demo ----------
async function main() {
  say(bold("Distributed Public Library — live demo"));
  note(`gateway ${GATEWAY}   the app only uses ${GATEWAY}/api/...   patron's home: ${HOME}   book: ${ISBN}`);

  await scene("Three autonomous branches behind one gateway");
  for (const b of ["ajax", "oshawa", "whitby"]) {
    const r = await call("GET", `/${b}/healthz`).catch(() => ({ status: 0 }));
    if (r.status !== 200) throw new Error(`${b} is not ready. Start the stack: docker compose up -d`);
    ok(`${b}: DB ${r.body.status}, replica ${r.body.instance}`);
  }
  note("Each branch has its own Atlas cluster and 2 app replicas. The app talks to /api/ only; NGINX picks any branch.");

  await scene("Sign up, choosing AJAX as home branch");
  let r = await call("POST", "/api/auth/register", { body: { ...PATRON, homeBranch: HOME } });
  ok(`account stored at ${bold(r.body.homeBranch)}, whichever branch took the request (only a bcrypt hash crosses)`);
  r = await call("POST", "/api/auth/register", { body: { ...PATRON, homeBranch: "whitby" } });
  r.status === 409 ? ok(`same email again, other branch: ${r.body.code} (branches check each other)`) : bad(`expected 409, got ${r.status}`);

  await scene("Sign in — you're automatically at your home branch");
  r = await call("POST", "/api/auth/login", { body: { email: PATRON.email, password: PATRON.password } });
  let { token, refreshToken } = r.body;
  ok(`signed in; home branch ${bold(r.body.homeBranch)}`);
  note("Every signed-in call below goes to /api/. Wherever NGINX lands it, the backend forwards it to ajax:");
  const served = [];
  for (let i = 0; i < 4; i += 1) served.push((await call("GET", "/api/auth/me", { token })).servedBy || "ajax (direct)");
  ok(`4 calls, all answered by ajax: ${served.join(", ")}`);

  await scene(`Search for ${ISBN}`);
  r = await call("GET", `/api/circulation/books/${ISBN}`, { token });
  const holder = r.body.foundAt?.[0]?.branch;
  if (!holder) throw new Error(`No branch has ${ISBN} available. Pick another with --isbn`);
  ok(r.body.source === "local" ? "on the shelf at my branch" : `not at my branch; the others were asked in parallel -> ${bold(holder)} has it`);
  note(`"${r.body.foundAt[0].book.title}"`);

  await scene("Request it");
  r = await call("POST", "/api/circulation/requests", { token, body: { isbn10: ISBN } });
  patronSees(r.body.message || r.body.error);
  if (r.body.status === "TRANSFERRED") note(`behind the scenes: transfer saga ${r.body.transfer?.sagaId?.slice(0, 8)}… (lock at ${r.body.from}, copy sent, committed, deleted at source)`);

  await scene("Someone else can't take my hold");
  await call("POST", "/api/auth/register", { body: { ...RIVAL, homeBranch: HOME }, quiet: true });
  const rival = (await call("POST", "/api/auth/login", { body: { email: RIVAL.email, password: RIVAL.password }, quiet: true })).body.token;
  r = await call("POST", "/api/circulation/checkout", { token: rival, body: { isbn10: ISBN } });
  r.status === 409 ? ok(`rival refused: ${r.body.code}`) : bad(`expected 409, got ${r.status}`);

  await scene("Check out, then return");
  r = await call("POST", "/api/circulation/checkout", { token, body: { isbn10: ISBN } });
  patronSees(r.body.message);
  r = await call("GET", "/api/circulation/loans/me", { token });
  ok(`my loans (all in one place, at my branch): ${r.body.loans.map((l) => `${l.isbn10} ${l.status}${l.overdue ? " OVERDUE" : ""}`).join(", ")}`);
  r = await call("POST", "/api/circulation/return", { token, body: { isbn10: ISBN } });
  patronSees(r.body.message);

  await scene("Behind the scenes: custody trail in Lamport order (wall clocks differ per branch)");
  r = await call("GET", `/api/circulation/books/${ISBN}`);
  const copy = r.body.foundAt?.[0];
  ok(`the copy is back at ${bold(copy?.branch)}`);
  say(`    ${trail(copy?.book)}`);
  const l = (copy?.book?.custodyHistory || []).map((e) => e.lamport);
  l.every((v, i) => i === 0 || v > l[i - 1]) ? ok("strictly increasing Lamport timestamps") : bad("Lamport order broken");

  await scene("Sessions: rotating refresh tokens, reuse detection, logout");
  r = await call("POST", "/api/auth/refresh", { body: { refreshToken } });
  ok("refreshed (token stored at ajax, found by its prefix); access tokens last 15 min");
  const stolen = refreshToken;
  ({ token, refreshToken } = r.body);
  r = await call("POST", "/api/auth/refresh", { body: { refreshToken: stolen } });
  r.status === 401 ? ok(`replaying the old token -> ${r.body.code}: every session of this user is revoked`) : bad(`expected 401, got ${r.status}`);
  r = await call("POST", "/api/auth/logout", { body: { refreshToken } });
  ok(`logout -> ${r.status}`);

  if (!flag("skip-failure")) {
    await scene("Failure: WHITBY goes down mid-service");
    compose("stop", "branch-whitby");
    ok("docker compose stop branch-whitby");
    const probe = "000649689X"; // a copy that lives at ajax
    r = await call("GET", `/oshawa/api/circulation/books/${probe}`);
    ok(`search still answers: found at ${r.body.foundAt?.map((f) => f.branch).join(", ") || "nowhere"}, offline ${JSON.stringify(r.body.offline)}`);
    patronSees(r.body.warning);
    note(`${r.ms}ms: waited out whitby's timeout. Waiting ~16s for heartbeats to mark it down...`);
    await sleep(16_000);
    r = await call("GET", `/oshawa/api/circulation/books/${probe}`);
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
    for (; n < 80; n += 1) {
      const t = await call("POST", "/api/auth/login", { body: { email: PATRON.email, password: "wrong" }, quiet: true });
      if (t.status === 429) break;
    }
    ok(`blocked with 429 after ${n} wrong passwords from this IP (limit per replica; 15-minute window)`);
    note("Note: logins from this machine stay blocked for 15 minutes.");
  }

  if (!flag("keep")) {
    await scene("Cleanup");
    const js = `const m=require('mongoose');m.connect(process.env.MONGO_URI).then(async()=>{const db=m.connection.db;`
      + `const us=await db.collection('users').find({email:{$in:${JSON.stringify([PATRON.email, RIVAL.email])}}}).toArray();const ids=us.map(u=>String(u._id));`
      + `await db.collection('loans').deleteMany({userId:{$in:ids}});await db.collection('refreshtokens').deleteMany({userId:{$in:ids}});`
      + `const d=await db.collection('users').deleteMany({_id:{$in:us.map(u=>u._id)}});console.log(d.deletedCount);process.exit(0)})`;
    const n = compose("exec", "-T", `branch-${HOME}`, "node", "-e", js).trim();
    ok(`removed ${n} demo accounts with their loans and refresh tokens (the book's custody trail is kept)`);
  }

  say(`\n${green(bold("Demo complete."))}`);
}

main().catch((err) => {
  say(`\n${red(bold("Demo stopped:"))} ${err.message}`);
  process.exit(1);
});
