# Distributed Public Library Management System

**Course:** SOFE 4790U — Distributed Systems (Ontario Tech University)

---

## 1. Overview

A distributed, multi-branch public library system for a regional network spanning **Ajax**, **Oshawa** and **Whitby**. There is no central database: each branch is an autonomous node backed by its own isolated MongoDB Atlas cluster.

Patrons reach every branch through one API gateway. When a book isn't at their branch, the branch asks its peers in parallel, still answers if a peer is offline, and can move the copy over with a fault-tolerant **inter-library transfer saga**.

---

## 2. System Architecture

```mermaid
flowchart TB
    Client["Client (React web app)"]
    Gateway["NGINX gateway :8090<br/>• /ajax/*, /oshawa/*, /whitby/* → that branch<br/>• round-robin over 2 replicas per branch<br/>• blocks /internal/* (403)"]

    Client -->|"HTTP/REST + JWT { userId, role, homeBranch }"| Gateway

    Gateway --> Ajax["branch-ajax ×2<br/>(Express)"]
    Gateway --> Oshawa["branch-oshawa ×2<br/>(Express)"]
    Gateway --> Whitby["branch-whitby ×2<br/>(Express)"]

    Ajax <-->|"/internal/* + x-internal-secret + x-lamport-timestamp"| Oshawa
    Oshawa <-->|"/internal/*"| Whitby
    Ajax <-->|"/internal/*"| Whitby

    Ajax <--> MongoAjax[("Atlas cluster: ajax<br/>(3-node replica set)")]
    Oshawa <--> MongoOshawa[("Atlas cluster: oshawa<br/>(3-node replica set)")]
    Whitby <--> MongoWhitby[("Atlas cluster: whitby<br/>(3-node replica set)")]
```

### Core principles

* **One codebase, identity from the environment:** all branches run the same `server/` code, configured by `BRANCH_ID`, `MONGO_URI`, `PEER_URLS` and `PORT`. A misconfigured branch refuses to boot (`src/config/env.js`).
* **Strict database isolation:** a branch only ever talks to its own cluster. Everything cross-branch goes over HTTP `/internal/*`, authenticated with a shared `INTERNAL_API_SECRET`.
* **Stateless app tier:** auth is a JWT (`{ userId, role, homeBranch }`) that any replica of any branch can verify, so replicas scale horizontally behind NGINX.

---

## 3. Distributed Systems Features

| Concept | Implementation |
| :--- | :--- |
| **Federated search** (`services/catalogSearch.js`) | Local first. On a miss, the branch sends `GET /internal/books/:isbn10` to every healthy peer in parallel (`Promise.allSettled`, `PEER_TIMEOUT_MS` = 3 s). The response lists `foundAt` (which branches have it) and `offline`. |
| **Failover** | `discoveryService` heartbeats every peer (`DISCOVERY_INTERVAL_MS` = 5 s) and marks a peer unhealthy after 3 failed probes. Search then skips it instead of waiting out the timeout, and adds a `warning` naming unreachable branches. One healthy probe brings it back. |
| **Inter-library transfer saga** (`services/transferSaga.js`) | 1) lock the copy locally (`status: IN_TRANSIT`, `activeTransferId`), 2) `POST /internal/transfers/receive` to the target, 3) delete locally and log `COMMITTED`. If step 2 fails or times out, a compensating step unlocks the copy (`ROLLED_BACK`). The receiver is idempotent by `sagaId`, so retries never duplicate a book. |
| **Request to home branch** (`POST /api/circulation/requests`) | A patron asks *their home branch* for a book. It searches the network, then asks a branch that has it (`POST /internal/transfers/send`) to run the transfer saga towards home. If that branch loses its copy to someone else (409), the next holder is asked. |
| **Saga crash recovery** (`services/recoveryService.js`) | On boot and every 60 s, the source branch looks for transfers a crash left half-done (`RESERVED`/`COMPENSATING` for 30 s+, or a lock with no log). It asks the target (`GET /internal/transfers/:sagaId`): if the target committed, the source finishes (deletes its copy); if the target never got it, the source unlocks the copy. If the target is unreachable, nothing is decided until the next sweep, so a copy is never duplicated or lost. |
| **Concurrency control** | Every copy is one `Library` document. Checkout and the transfer lock are single atomic `findOneAndUpdate`s that only match `status: AVAILABLE, activeTransferId: null`, so of N simultaneous requests exactly one wins and the rest get `409`. Returns are atomic too, and only the borrower can return. |
| **Loans & custody** (`models/Loan.js`, `Library.custodyHistory`) | Each checkout creates a `Loan` at that branch. Every copy carries a `custodyHistory` (`TRANSFER_IN`, `CHECKOUT`, `RETURN`, each with its branch and Lamport time) that travels with it between branches, and an `originBranch`. A copy returned away from its origin is sent home automatically; if home is down, it stays available where it was returned. |
| **Home branch accounts** | A user exists only in their home branch's DB. Signup at any branch takes a `homeBranch` and creates the account there (only a bcrypt hash crosses branches), after checking no branch already has that email. Login works at any branch: if the user isn't local, the branches are asked and the home branch verifies the password. The response's `homeBranch` tells the client which `/<branch>/` to use. |
| **Lamport logical clocks** (`utils/lamportClock.js`) | Branches may have skewed wall clocks (different timezones), so cross-branch ordering uses Lamport time only. Every peer request and response carries `x-lamport-timestamp`, and the receiver applies $C = \max(C_{\text{local}}, C_{\text{incoming}}) + 1$. Each branch runs 2 replicas with their own clocks, so before stamping a copy's next custody event a replica also syncs past that copy's latest stamp. That keeps every copy's trail in order. |
| **Replication & high availability** | Each Atlas cluster is a 3-node replica set. The driver fails over to a new primary on its own, and `retryWrites=true&w=majority` retries a write once and confirms it on a majority. Each branch also runs 2 app replicas. Docker health-checks them via `GET /healthz` (503 without a DB), and NGINX retries the other replica on an error, timeout, 502 or 503 (never on POST). |

### Planned (designed, not built yet)

* Holding a requested copy for the patron who asked (today anyone at the home branch can check it out once it arrives)
* Google sign-up choosing a home branch other than the one whose URL started it
* Physical vs. digital media (digital titles borrowable remotely without a transfer)
* Recommendations service

---

## 4. API

All public routes go through the gateway as `http://localhost:8090/<branch>/...`, e.g. `/oshawa/api/circulation/books/0262033844`.

| Method & path | Auth | Purpose |
| :--- | :--- | :--- |
| `GET /healthz` | – | Readiness: 200 when this replica's DB is connected, else 503 |
| `POST /api/auth/register` | – | `{ email, password, name, homeBranch }` → `{ token, user, homeBranch }`. Works at any branch; the account is created at `homeBranch`. 409 `EMAIL_TAKEN`, 503 `HOME_BRANCH_OFFLINE`. |
| `POST /api/auth/login` | – | `{ email, password }` → `{ token, user, homeBranch }`, at any branch |
| `GET /api/auth/me` | JWT | Current user (read from their home branch) |
| `GET /api/auth/google` | – | Start Google sign-in, which ends at `CLIENT_URL/auth/callback#token=…`. A new Google user's home is the branch in the URL. |
| `GET /api/circulation/books/:isbn10` | – | Federated search: 200 with `foundAt`, or 404. Includes `offline` and `warning` when peers are down. |
| `POST /api/circulation/requests` | JWT (at your home branch) | `{ isbn10 }`: bring a copy here from whichever branch has it. → `TRANSFERRED` / `AVAILABLE_HERE`; 404 / 409 otherwise; 400 `NOT_HOME_BRANCH` |
| `POST /api/circulation/checkout` | JWT | `{ isbn10 }`: borrow a copy held here. 409 `BOOK_UNAVAILABLE`, 404 `BOOK_NOT_FOUND`. |
| `POST /api/circulation/return` | JWT | `{ isbn10 }`: return a copy you borrowed here. `routedTo` names its origin branch if it was sent home. 409 `NOT_BORROWED_BY_YOU`. |
| `GET /api/circulation/loans/me` | JWT | Your loans at this branch, newest first |
| `POST /api/circulation/transfers` | JWT, librarian | `{ isbn10, targetBranch }`: push a copy from this branch |
| `/internal/health`, `/internal/books/:isbn10`, `/internal/transfers/{receive,send,:sagaId}`, `/internal/users{,/exists,/verify,/:id}` | `x-internal-secret` | Peer-only; blocked at the gateway |

Errors are JSON: `{ "error": "...", "code": "..." }`.

---

## 5. Repository Structure

```text
Final_Project/
├── .env                       # Your secrets (git-ignored), see "Environment" below
├── .github/workflows/ci.yml   # Tests (with a throwaway mongo:7) + Docker build
├── docker-compose.yml         # NGINX gateway + 3 branches × 2 replicas (DBs are on Atlas)
├── gateway/nginx.conf         # Per-branch routing, load balancing, /internal/* firewall
├── docs/tdd/                  # TDD evidence reports
├── client/                    # React frontend (Vite)
└── server/                    # One Express backend, runs as ajax / oshawa / whitby
    ├── Dockerfile
    ├── src/
    │   ├── config/            # env.js (validated config), checkConnections.js
    │   ├── models/            # User, Library (one doc per copy), Loan, TransferLog
    │   ├── controllers/       # auth, circulation, internal (peer) handlers
    │   ├── services/          # catalogSearch, discoveryService, transferSaga, recoveryService, peerClient, userService
    │   ├── middlewares/       # JWT requireAuth / requireRole
    │   ├── routes/            # /api/auth, /api/circulation, /internal
    │   ├── utils/             # lamportClock, AppError
    │   ├── seeds/             # seedBranch.js (CSV importer)
    │   └── server.js          # Express app, error handler, boot, graceful shutdown
    └── tests/                 # see "Tests" below
```

---

## 6. Getting Started

### Prerequisites

* **Docker & Docker Compose**
* **Node.js 24+ & npm** (for tests and local runs)
* Three **MongoDB Atlas** clusters (one per branch), with your IP on each cluster's **Network Access** list

### Environment

Create `.env` in the repo root (never commit it):

```bash
MONGO_URI_AJAX=mongodb+srv://...
MONGO_URI_OSHAWA=mongodb+srv://...
MONGO_URI_WHITBY=mongodb+srv://...

JWT_SECRET=long-random-string        # required when NODE_ENV=production
JWT_EXPIRES_IN=1h
INTERNAL_API_SECRET=another-random-string
CLIENT_URL=http://localhost:5173

# Optional: Google login returns 501 without these
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxx
```

Generate a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

> Under Docker, `JWT_SECRET` and `INTERNAL_API_SECRET` come from this `.env` too; without them, dev defaults are used.

For Google login, register one redirect URI per branch in Google Cloud Console:
`http://localhost:8090/{ajax,oshawa,whitby}/api/auth/google/callback`.

### Run the network (Docker)

```bash
docker compose up --build
```

This starts the gateway at **http://localhost:8090** and 2 replicas of each branch, with hot reload on `server/src/`.

```bash
curl http://localhost:8090/oshawa/healthz
```

### Run without Docker (one terminal per branch, PowerShell, from `server/`)

```bash
$env:BRANCH_ID="ajax"; $env:PORT="3001"; npm run dev
```

Repeat with `oshawa` on port 3002 and `whitby` on port 3003. There's no gateway in this mode, so Google login won't work.

### Seed a branch

```bash
$env:BRANCH_ID="ajax"; npm run seed ./path/to/ajax_items.csv
```

### Troubleshooting

* **502 from the gateway / `MongoDB connect failed (attempt N)` in the logs:** your IP isn't on the cluster's Network Access list, or the cluster is paused. Fix it in Atlas; the branch keeps retrying every 5 s and comes up by itself (`/healthz` returns 503 until then).
* **Gateway won't start:** something else is using port 8090.

---

## 7. Tests

Run from `server/`:

| Command | What it covers | Needs |
| :--- | :--- | :--- |
| `npm test` | Auth/JWT/OAuth, home-branch signup and login across branches, env validation, federated search, failover (dead or unhealthy peers, warnings, heartbeats), DB retry at boot | nothing; DB mocked, peers are local HTTP servers. **Runs in CI.** |
| `npm run test:db` | Concurrency (10 parallel checkouts, checkout vs. transfer race); requests to home branch; checkout/return/loans/custody order across lagging replicas; returns routed home; **failure demos**: target dies mid-transfer, source crashes at each saga step and recovery repairs it | a real MongoDB (`MONGO_URI`, or `MONGO_URI_OSHAWA` from `.env`); writes and deletes `TEST-CC-*` / `TEST-CR-*` rows. **Runs in CI** (throwaway `mongo:7`). |
| `npm run test:trans` | Transfer saga: commit, rollback on timeout, double-transfer, idempotent receive | Atlas (oshawa); writes and deletes `TEST-*` rows |
| `npm run test:lb` | NGINX load balancing and replica failover | the Docker stack running |

Add `--verbose` (e.g. `npx jest tests/failover.test.js --verbose`) to see each test as it runs.
