# TDD evidence: peer failover + checkout concurrency

**Source plan:** none; journeys derived during this run from the `test.todo` stubs in
`server/tests/failover.test.js` and `server/tests/concurrency.test.js`.
**Branch:** `feat/failover-concurrency` — RED `380b532`, GREEN `2fa9ce6`.

## User journeys

1. As a patron at one branch, when another branch is down, I still get results from the branches that are up,
   plus a warning naming the down branch, so one outage never breaks search.
2. As two patrons checking out the last copy at the same moment, exactly one of us gets it and the other gets a
   clear 409, and a copy that is mid-transfer to another branch can't be borrowed (or vice versa).

## Task report

| Task | Summary | Command | RED | GREEN |
|---|---|---|---|---|
| Failover | `catalogSearch` reports heartbeat-unhealthy peers as offline without calling them and adds `warning`; boot starts heartbeats; JSON error handler | `npx jest tests/failover.test.js` | 4 failed (no `warning`, unhealthy peer silently dropped, HTML 500) | 7 passed |
| Concurrency | `POST /api/circulation/checkout` = one atomic `findOneAndUpdate` on `status: AVAILABLE, activeTransferId: null`; `Library.borrowedBy` | `npx jest tests/concurrency.test.js` | 4 failed (route missing → 404) | 5 passed, 3 extra re-runs 5/5 |
| Regression | Whole suite + live-Atlas saga test | `npm test`, `npm run test:trans` | — | 34 passed; 4 passed |

## What the tests guarantee

| # | Guarantee | Test | Type | Result |
|---|---|---|---|---|
| 1 | Unreachable peer → partial results, `offline` lists it, `warning` names it | failover: *returns partial results…* | integration (real HTTP peers, mocked DB) | PASS |
| 2 | Peer marked unhealthy is not called but still reported offline | failover: *already marked unhealthy…* | integration | PASS |
| 3 | No warning when every peer answered | failover: *no warning…* | integration | PASS |
| 4 | All peers down → JSON 404 with warning, never 500 | failover: *all peers down…* | integration | PASS |
| 5 | Unexpected error → JSON 500, message not leaked | failover: *local DB failure…* | integration | PASS |
| 6 | Heartbeat: unhealthy after 3 failures, healthy after 1 success | failover: *marks a peer unhealthy…* | unit (existing code, regression guard) | PASS |
| 7 | `start()` probes immediately, `stop()` clears the timer | failover: *start() probes…* | unit (existing code) | PASS |
| 8 | 10 parallel checkouts of the last copy → exactly 1×200, 9×409 | concurrency: *only one of 10…* | integration (real MongoDB) | PASS |
| 9 | Checkout racing a transfer (5 rounds) → exactly one wins and the DB matches | concurrency: *checkout racing a transfer…* | integration (real MongoDB) | PASS |
| 10 | In-transit copy can't be checked out | concurrency: *in transit…* | integration | PASS |
| 11 | Borrowed copy can't be transferred | concurrency: *borrowed copy…* | integration (existing code) | PASS |
| 12 | Checkout: 404 unknown, 400 no isbn10, 401 no JWT | concurrency: *validates input and auth* | integration | PASS |

Live check (Docker, `whitby` stopped): search from oshawa returned ajax's copy, `offline: ["whitby"]` and the
warning; 3.05 s on the first request (timeout), 0.26 s once heartbeats marked whitby unhealthy.

## Coverage and known gaps

`npx jest --coverage --collectCoverageFrom='src/**/*.js'` → 72% lines overall (below the 80% target).
New code: `catalogSearch.js` 100% lines; `checkout` covered except its catch. Uncovered and **not** touched here:
`server.js` boot/shutdown, `transferBook` controller, `receiveTransfer` (only exercised by the live-Atlas
`test:trans`, which `npm test` excludes).

- `concurrency.test.js` needs a real MongoDB: CI's `mongo:7` service, or `MONGO_URI_OSHAWA` (Atlas) locally.
  It writes and deletes `TEST-CC-*` rows only.
- No return/check-in endpoint yet, so a borrowed copy stays BORROWED.
- A failed search call doesn't count toward a peer's heartbeat failures; only heartbeats mark peers down.
