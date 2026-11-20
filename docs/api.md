# Library API: contract for the frontend

Everything the React app needs to talk to the backend. Every example here was run against the real stack.

## Basics

| | |
| :--- | :--- |
| **Base URL** | `http://localhost:8090/<branch>` where `<branch>` is `ajax`, `oshawa` or `whitby` |
| **Which branch?** | Before login, any. After login, use the **`homeBranch`** from the login response for everything. |
| **Format** | JSON in, JSON out. Send `Content-Type: application/json`. |
| **Auth** | `Authorization: Bearer <token>` on routes marked 🔒 |
| **CORS** | Allowed origin: `http://localhost:5173` (set `CORS_ORIGINS` on the server for others). No cookies are used. |
| **Rate limits** | `register`, `login`: 10 attempts per IP per 15 min; `refresh`: 30. Over the limit you get `429 RATE_LIMITED` with a `Retry-After` header (in seconds). |

### Errors

Every error has the same shape. Branch on `code`, not on the message text.

```json
{ "error": "Human readable message", "code": "MACHINE_CODE", "details": { "optional": "context" } }
```

| Status | Codes |
| :--- | :--- |
| 400 | `BAD_REQUEST`, `INVALID_JSON`, `INVALID_HOME_BRANCH`, `NOT_HOME_BRANCH` |
| 401 | `UNAUTHORIZED` (no token), `TOKEN_EXPIRED` (refresh it), `TOKEN_INVALID`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED` |
| 403 | `FORBIDDEN` (wrong role) |
| 404 | `BOOK_NOT_FOUND`, `USER_NOT_FOUND` |
| 409 | `EMAIL_TAKEN`, `BOOK_UNAVAILABLE`, `NOT_BORROWED_BY_YOU`, `RETRY` |
| 429 | `RATE_LIMITED` |
| 503 | `HOME_BRANCH_OFFLINE`, `PEER_UNAVAILABLE` |
| 500 | `INTERNAL_ERROR` (never includes internals) |

---

## Sessions

Sign-in returns two tokens:

| Token | Lifetime | Use |
| :--- | :--- | :--- |
| `token` (JWT) | 15 min | `Authorization: Bearer …` on 🔒 routes |
| `refreshToken` (opaque, `"<branch>.…"`) | 7 days, **single use** | swap for a new pair at `/api/auth/refresh` |

Recommended client flow:

1. Login or signup: store `token`, `refreshToken` and `homeBranch`.
2. Call 🔒 routes at `/<homeBranch>/api/...`.
3. On `401 TOKEN_EXPIRED`, call `/refresh` **once** with the stored `refreshToken`, store **both** new values, then retry the request.
4. If refresh fails (`INVALID_REFRESH_TOKEN` or `REFRESH_TOKEN_REUSED`), or you get `TOKEN_INVALID`, the user must log in again.
5. Never send the same refresh token twice. A reused token is treated as stolen, and **all** of that user's sessions are revoked. If several requests get `TOKEN_EXPIRED` at once, run one shared refresh and make the others wait for it.

---

## Auth: `/api/auth`

### `POST /register`

Works at any branch. The account is created at `homeBranch`.

```json
{ "email": "amy@example.com", "password": "at-least-8-chars", "name": "Amy", "homeBranch": "ajax" }
```

`201`:

```json
{ "token": "eyJ…", "refreshToken": "ajax.Xb3…", "homeBranch": "ajax",
  "user": { "_id": "6aff…", "email": "amy@example.com", "name": "Amy", "role": "patron", "homeBranch": "ajax", "createdAt": "…" } }
```

Errors: `400` (bad email, password under 8 characters, missing or unknown `homeBranch`: `INVALID_HOME_BRANCH`); `409 EMAIL_TAKEN` (at any branch); `503 HOME_BRANCH_OFFLINE`.

### `POST /login`

Works at any branch.

```json
{ "email": "amy@example.com", "password": "…" }
```

`200`: the same shape as register. Error: `401 INVALID_CREDENTIALS` (the same answer for an unknown email and a wrong password).

### `POST /refresh`

Works at any branch.

```json
{ "refreshToken": "ajax.Xb3…" }
```

`200`: `{ token, refreshToken, user, homeBranch }`, a new pair. The old refresh token is now spent. Errors: `401 INVALID_REFRESH_TOKEN`, `401 REFRESH_TOKEN_REUSED`.

### `POST /logout`

Body: `{ "refreshToken": "ajax.Xb3…" }`. Returns `204`, and is idempotent. Afterwards, delete both tokens client-side. The current access token keeps working until it expires (at most 15 min).

### `GET /me` 🔒

`200 { "user": { … } }`, always read from the user's home branch.

### Google sign-in

1. Send the browser (a full page navigation, not `fetch`) to `/<branch>/api/auth/google`. **For a new user, that branch becomes their home.**
2. Google sends them back to `http://localhost:5173/auth/callback#token=…&refreshToken=…`.
3. Read both from `location.hash` with `new URLSearchParams(location.hash.slice(1))`, then call `/me` to get the user and `homeBranch`.
4. On failure, the fragment is `#error=<reason>`. `account_at_<branch>` means the email is already registered with a password at that branch, so the user should log in there.

---

## Circulation: `/api/circulation`

A **copy** looks like this (fields you'll use):

```json
{ "isbn10": "0002005883", "title": "Gilead", "author": [], "thumbnail": "http://…", "description": "…",
  "currentBranch": "whitby", "originBranch": "whitby",
  "status": "AVAILABLE | BORROWED | IN_TRANSIT | ON_HOLD",
  "heldFor": null, "holdExpiresAt": null, "borrowedBy": null,
  "custodyHistory": [ { "event": "TRANSFER_IN", "branch": "ajax", "from": "whitby", "lamport": 84 } ] }
```

`custodyHistory` is already in order (by Lamport time), so show it as-is. Don't sort it by wall-clock dates.

### `GET /books/:isbn10`

Search. Checks this branch first, then all others.

`200` when found somewhere:

```json
{ "isbn10": "0002005883", "source": "local | peers",
  "foundAt": [ { "branch": "whitby", "found": true, "book": { }, "lamportTimestamp": 30 } ],
  "offline": [], "warning": "Branch(es) unreachable: whitby. Results may be incomplete." }
```

`404` with the same shape and `foundAt: []` when no reachable branch has it. **When `warning` is present, show it**: some branches couldn't be searched.

### `POST /requests` 🔒 (at your home branch)

"Bring this book to my branch." Body: `{ "isbn10": "0002005883" }`

| Result | Meaning |
| :--- | :--- |
| `200 { status: "TRANSFERRED", from, to, holdExpiresAt, transfer }` | Moved here from `from`, and now **on hold for you** |
| `200 { status: "ON_HOLD", branch, holdExpiresAt, book }` | It was already on the shelf here (or already held for you); now held for you |
| `404 BOOK_NOT_FOUND` (with `offline`, `warning`) | No reachable branch can send it |
| `409 BOOK_UNAVAILABLE` | Every copy was just taken |
| `409 RETRY` | A copy appeared here mid-request; just retry |
| `400 NOT_HOME_BRANCH` | You called a branch other than your `homeBranch` |

Holds last `HOLD_DAYS` (3 by default). After that, the copy goes back on the shelf.

### `GET /holds/me` 🔒

`200 { "holds": [ { "isbn10", "title", "holdExpiresAt" } ] }`: copies waiting for you at this branch.

### `POST /checkout` 🔒

Body: `{ "isbn10": "…" }`. Takes a copy that is on the shelf, or on hold **for you**.

`200`:

```json
{ "message": "Book checked out", "book": { },
  "loan": { "_id": "…", "isbn10": "…", "userId": "…", "branch": "ajax", "status": "ACTIVE", "dueAt": "2026-12-03T…", "checkoutLamport": 93 } }
```

Errors: `409 BOOK_UNAVAILABLE` (borrowed, in transit, or held for someone else); `404 BOOK_NOT_FOUND` (not at this branch).

### `POST /return` 🔒

Body: `{ "isbn10": "…" }`. Return it at the branch where you borrowed it.

`200 { message, late, routedTo, … }`:
- `late: true` means it was returned after `dueAt`.
- `routedTo: "whitby"` means the copy was sent back to its origin branch.
- `routedTo: null` plus a `warning` means its origin was offline, so it stays here for now.

Errors: `409 NOT_BORROWED_BY_YOU`, `404 BOOK_NOT_FOUND`.

### `GET /loans/me` 🔒

`200 { "loans": [ { "isbn10", "status": "ACTIVE | RETURNED", "dueAt", "overdue": true, "checkoutLamport", "returnLamport" } ] }`, newest first, at this branch.

### `GET /loans/overdue` 🔒 librarian

`200 { "loans": [ ] }`: active loans past due at this branch, most overdue first. Patrons get `403 FORBIDDEN`.

### `POST /transfers` 🔒 librarian

Body: `{ "isbn10", "targetBranch" }`. Pushes a copy from this branch to another. Patrons get `403 FORBIDDEN`.

---

## Health

`GET /<branch>/healthz` → `200 { status: "ok", branchId, instance }`, or `503 { status: "db-unavailable" }` while that branch's database is unreachable.
