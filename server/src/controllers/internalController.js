// Peer-only handlers (mounted under /internal, guarded by INTERNAL_API_SECRET, blocked at NGINX).
const Library = require("../models/Library");
const TransferLog = require("../models/TransferLog");
const User = require("../models/User");
const lamportClock = require("../utils/lamportClock");
const AppError = require("../utils/AppError");
const discoveryService = require("../services/discoveryService");
const transferSaga = require("../services/transferSaga");
const userService = require("../services/userService");

const receiveEvent = (req) => lamportClock.sync(req.headers?.["x-lamport-timestamp"]); // max(local, sender) + 1
const stamp = (res) => res.set("x-lamport-timestamp", String(lamportClock.tick()));

// ---- Transfers ----

// POST /transfers/receive { sagaId, sourceBranch, bookData }: target side of the transfer saga. Idempotent by sagaId.
exports.receiveTransfer = async (req, res, next) => {
  try {
    const { sagaId, sourceBranch, bookData } = req.body;
    const targetBranch = discoveryService.selfBranch;
    receiveEvent(req);

    const existingLog = await TransferLog.findOne({ sagaId });
    if (existingLog && existingLog.status === "COMMITTED") {
      stamp(res);
      return res.status(200).json({ message: "Transfer already applied", sagaId });
    }

    // The copy's history may carry stamps from a sender replica whose clock ran ahead of the one that sent it.
    lamportClock.sync(Math.max(0, ...(bookData.custodyHistory || []).map((e) => e.lamport)));
    const tick = lamportClock.tick();
    let createdBook;
    try {
      createdBook = await Library.create({
        ...bookData,
        currentBranch: targetBranch,
        status: "AVAILABLE",
        activeTransferId: null,
        borrowedBy: null,
        originBranch: bookData.originBranch || sourceBranch,
        custodyHistory: [...(bookData.custodyHistory || []), { event: "TRANSFER_IN", branch: targetBranch, from: sourceBranch, lamport: tick }],
      });
    } catch (err) {
      // Copy already here: a retry after we crashed between inserting the copy and writing the log.
      if (err.code !== 11000) throw err;
    }

    await TransferLog.findOneAndUpdate(
      { sagaId },
      { sagaId, bookIsbn: bookData.isbn10, sourceBranch, targetBranch, status: "COMMITTED", lamportTimestamp: tick },
      { upsert: true },
    );

    res.set("x-lamport-timestamp", String(tick));
    if (!createdBook) return res.status(200).json({ message: "Transfer already applied", sagaId });
    res.status(201).json({ message: "Row transferred successfully", book: createdBook });
  } catch (err) {
    next(err);
  }
};

// POST /transfers/send { isbn10, targetBranch }: a peer (the patron's home branch) asks us to send a copy we hold.
exports.sendTransfer = async (req, res, next) => {
  try {
    receiveEvent(req);
    const { isbn10, targetBranch } = req.body || {};
    if (typeof isbn10 !== "string" || typeof targetBranch !== "string") throw AppError.badRequest("isbn10 and targetBranch are required");
    const transfer = await transferSaga.executeTransfer({ isbn10, targetBranch });
    stamp(res);
    res.status(200).json({ transfer });
  } catch (err) {
    next(err);
  }
};

// GET /transfers/:sagaId?isbn10=: did this branch receive that transfer? Used by crash recovery on the source.
exports.transferStatus = async (req, res, next) => {
  try {
    receiveEvent(req);
    stamp(res);
    const log = await TransferLog.findOne({ sagaId: req.params.sagaId });
    if (log) return res.status(200).json({ sagaId: log.sagaId, status: log.status });
    // Copy arrived but we crashed before writing the log: isbn10 is unique per branch, so its presence settles it.
    const isbn10 = req.query.isbn10;
    if (typeof isbn10 === "string" && (await Library.exists({ isbn10, currentBranch: discoveryService.selfBranch }))) {
      return res.status(200).json({ sagaId: req.params.sagaId, status: "COMMITTED" });
    }
    res.status(404).json({ sagaId: req.params.sagaId, status: "UNKNOWN" });
  } catch (err) {
    next(err);
  }
};

// ---- Catalog ----

// Peer asks "do you have this book?": 200 with the book if available here, 404 otherwise.
exports.lookupBook = async (req, res, next) => {
  try {
    receiveEvent(req);
    const book = await Library.findOne({
      isbn10: req.params.isbn10,
      currentBranch: discoveryService.selfBranch,
      status: "AVAILABLE",
    });
    stamp(res);
    if (!book) return res.status(404).json({ found: false, branch: discoveryService.selfBranch });
    res.status(200).json({ found: true, branch: discoveryService.selfBranch, book });
  } catch (err) {
    next(err);
  }
};

// ---- Users (each user lives only in their home branch's DB) ----

// GET /users/exists?email=
exports.userExists = async (req, res, next) => {
  try {
    receiveEvent(req);
    stamp(res);
    const email = typeof req.query.email === "string" ? req.query.email.toLowerCase().trim() : "";
    res.json({ exists: Boolean(email) && Boolean(await User.exists({ email })) });
  } catch (err) {
    next(err);
  }
};

// POST /users { email, name, passwordHash }: create an account whose home is this branch.
exports.createUser = async (req, res, next) => {
  try {
    receiveEvent(req);
    const { email, name, passwordHash } = req.body || {};
    if (typeof email !== "string" || typeof passwordHash !== "string" || !passwordHash.startsWith("$2")) {
      throw AppError.badRequest("email and a bcrypt passwordHash are required");
    }
    const user = await userService.createHere({ email, name, passwordHash });
    stamp(res);
    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
};

// POST /users/verify { email, password }: 200 { user } on a match, 401 wrong password, 404 no such user here.
exports.verifyUser = async (req, res, next) => {
  try {
    receiveEvent(req);
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string") throw AppError.badRequest("email and password are required");
    const { exists, user } = await userService.verifyHere(email, password);
    stamp(res);
    if (!exists) return res.status(404).json({ found: false });
    if (!user) return res.status(401).json({ error: "Invalid email or password", code: "INVALID_CREDENTIALS" });
    res.json({ user });
  } catch (err) {
    next(err);
  }
};

// GET /users/:id
exports.getUser = async (req, res, next) => {
  try {
    receiveEvent(req);
    stamp(res);
    const user = await User.findById(req.params.id).catch(() => null); // malformed id -> not found
    if (!user) return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
    res.json({ user });
  } catch (err) {
    next(err);
  }
};
