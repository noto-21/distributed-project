// Patron and librarian circulation: search, request-to-home-branch, checkout, return, loans, manual transfers.
const transferSaga = require("../services/transferSaga");
const catalogSearch = require("../services/catalogSearch");
const { callPeer } = require("../services/peerClient");
const lamportClock = require("../utils/lamportClock");
const AppError = require("../utils/AppError");
const Library = require("../models/Library");
const Loan = require("../models/Loan");
const env = require("../config/env");
const { NAMES } = require("../middlewares/homeRouter");

// What the patron reads. Structured fields stay alongside for the UI.
const branchName = (b) => NAMES[b] || b;
const day = (d) => new Date(d).toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "America/Toronto" });
const heldMsg = (title, home, until) => `“${title}” is on hold for you at ${branchName(home)} until ${day(until)}.`;

const MAX_BOOKS = 3; // borrowed + on hold, per patron
const MAX_RENEWALS = 2;

// Copies this patron has in hand at this branch: borrowed by them or waiting on hold for them.
const inHandFilter = (userId) => ({
  currentBranch: env.branchId,
  $or: [{ status: "BORROWED", borrowedBy: userId }, { status: "ON_HOLD", heldFor: userId }],
});

// shortcut: count-then-act, so two simultaneous requests can both pass at 2 books; fine for patrons, add a per-user lock if it matters.
async function assertUnderLimit(userId) {
  if ((await Library.countDocuments(inHandFilter(userId))) >= MAX_BOOKS) {
    throw AppError.conflict(`You can have at most ${MAX_BOOKS} books borrowed or on hold. Return one or cancel a hold first.`, "LIMIT_REACHED");
  }
}

// A copy that belongs to another branch goes back there; if that branch is down it stays available here.
async function sendToOrigin(book, isbn10, message) {
  const origin = book.originBranch;
  if (!origin || origin === env.branchId) return { message, book, routedTo: null };
  try {
    const transfer = await transferSaga.executeTransfer({ isbn10, targetBranch: origin });
    return { message: `${message} It's going back to ${branchName(origin)}.`, routedTo: origin, transfer };
  } catch (err) {
    return { message, book, routedTo: null, warning: `Could not send it home to ${origin} yet (${err.message}); it stays available here.` };
  }
}

const requireIsbn = (body) => {
  const { isbn10 } = body || {};
  if (typeof isbn10 !== "string" || !isbn10) throw AppError.badRequest("isbn10 is required");
  return isbn10;
};

// Each branch runs several replicas, each with its own in-memory Lamport clock. The copy's custody history is
// the state they share, so its last event counts as a received message: the next stamp is always later.
async function stampFor(isbn10) {
  const doc = await Library.findOne({ isbn10, currentBranch: env.branchId }, { custodyHistory: { $slice: -1 } }).lean();
  return lamportClock.sync(doc?.custodyHistory?.[0]?.lamport ?? 0);
}

// POST /api/circulation/transfers { isbn10, targetBranch }: librarian pushes a copy from this branch.
exports.transferBook = async (req, res, next) => {
  try {
    const { isbn10, targetBranch } = req.body || {};
    if (!isbn10 || !targetBranch) throw AppError.badRequest("isbn10 and targetBranch are required");
    const result = await transferSaga.executeTransfer({ isbn10, targetBranch });
    res.status(200).json({ message: "Book transferred successfully", transfer: result });
  } catch (err) {
    next(err);
  }
};

// POST /api/circulation/requests { isbn10 }: a patron at their home branch asks for a copy held elsewhere.
// Search the network, then ask a branch that has it to run the transfer saga towards us. If that branch
// loses a race for its copy (409), try the next one.
exports.requestTransfer = async (req, res, next) => {
  try {
    const isbn10 = requireIsbn(req.body);
    const home = req.user.homeBranch;
    if (home !== env.branchId) {
      throw new AppError(`Requests are handled by your home branch '${home}': use /${home}/api/...`, 400, "NOT_HOME_BRANCH");
    }

    const { userId } = req.user;
    const holdExpiresAt = () => new Date(Date.now() + env.holdDays * 86_400_000);
    const alreadyHeld = await Library.findOne({ isbn10, currentBranch: home, status: "ON_HOLD", heldFor: userId }).lean();
    if (alreadyHeld) {
      return res.status(200).json({ status: "ON_HOLD", message: heldMsg(alreadyHeld.title, home, alreadyHeld.holdExpiresAt), branch: home, holdExpiresAt: alreadyHeld.holdExpiresAt, book: alreadyHeld });
    }
    await assertUnderLimit(userId);

    // On the shelf here: hold it for this patron (atomic, so two requesters can't both get it).
    const heldHere = await Library.findOneAndUpdate(
      { isbn10, currentBranch: home, status: "AVAILABLE", activeTransferId: null },
      { $set: { status: "ON_HOLD", heldFor: userId, holdExpiresAt: holdExpiresAt() } },
      { returnDocument: "after" },
    );
    if (heldHere) {
      return res.status(200).json({ status: "ON_HOLD", message: heldMsg(heldHere.title, home, heldHere.holdExpiresAt), branch: home, holdExpiresAt: heldHere.holdExpiresAt, book: heldHere });
    }

    const search = await catalogSearch.findBook(isbn10);
    // A copy was returned here between our hold attempt and the search: let the client simply retry.
    if (search.source === "local") throw AppError.conflict("A copy just became available here, try again", "RETRY");

    const offline = [...search.offline];
    let lostRace = false;
    for (const { branch } of search.foundAt) {
      try {
        const { status, body } = await callPeer(branch, "POST", "/transfers/send", { isbn10, targetBranch: home, holdFor: userId });
        if (status === 200) {
          const arrived = await Library.findOne({ isbn10, currentBranch: home }, { holdExpiresAt: 1, title: 1 }).lean();
          const title = arrived?.title ?? search.foundAt.find((f) => f.branch === branch)?.book?.title ?? isbn10;
          return res.status(200).json({
            status: "TRANSFERRED",
            message: `${branchName(branch)} is sending “${title}” to your branch (${branchName(home)}). It will be held for you until ${day(arrived?.holdExpiresAt)}.`,
            from: branch,
            to: home,
            holdExpiresAt: arrived?.holdExpiresAt ?? null,
            transfer: body.transfer,
          });
        }
        if (status === 409) lostRace = true;
      } catch {
        offline.push(branch);
      }
    }

    const warning = offline.length ? `Branch(es) unreachable: ${offline.join(", ")}.` : undefined;
    if (lostRace) throw AppError.conflict("Every available copy was taken or is already moving", "BOOK_UNAVAILABLE", { offline, warning });
    res.status(404).json({ error: "No branch has this book available right now", code: "BOOK_NOT_FOUND", offline, warning });
  } catch (err) {
    next(err);
  }
};

// POST /api/circulation/checkout { isbn10 }: borrow a copy held at this branch.
// One atomic conditional update: of N simultaneous requests only one can match status AVAILABLE,
// and a copy locked by a transfer (activeTransferId set) can't be borrowed mid-flight.
exports.checkout = async (req, res, next) => {
  try {
    const isbn10 = requireIsbn(req.body);
    const { userId } = req.user;
    // Checking out your own hold doesn't add a book; taking one off the shelf does.
    if (!(await Library.exists({ isbn10, currentBranch: env.branchId, status: "ON_HOLD", heldFor: userId }))) {
      await assertUnderLimit(userId);
    }
    const lamport = await stampFor(isbn10);

    const book = await Library.findOneAndUpdate(
      {
        isbn10,
        currentBranch: env.branchId,
        activeTransferId: null,
        $or: [{ status: "AVAILABLE" }, { status: "ON_HOLD", heldFor: userId }], // a hold is only for its patron
      },
      {
        $set: { status: "BORROWED", borrowedBy: userId, heldFor: null, holdExpiresAt: null },
        $push: { custodyHistory: { event: "CHECKOUT", branch: env.branchId, lamport, userId } },
      },
      { returnDocument: "after" },
    );
    if (!book) {
      // Lost the race or never here: tell the two apart for the caller.
      const exists = await Library.exists({ isbn10, currentBranch: env.branchId });
      throw exists
        ? AppError.conflict(`Book '${isbn10}' is not available for checkout`, "BOOK_UNAVAILABLE")
        : AppError.notFound(`Book '${isbn10}' is not held at branch '${env.branchId}'`, "BOOK_NOT_FOUND");
    }

    try {
      const loan = await Loan.create({
        isbn10, userId, branch: env.branchId, checkoutLamport: lamport, dueAt: new Date(Date.now() + env.loanDays * 86_400_000),
      });
      res.status(200).json({ message: `Enjoy “${book.title}”! Please return it by ${day(loan.dueAt)}.`, book, loan });
    } catch (err) {
      // No loan record means nobody could ever return it: give the copy back rather than strand it.
      await Library.updateOne(
        { _id: book._id, borrowedBy: userId },
        { $set: { status: "AVAILABLE", borrowedBy: null }, $pull: { custodyHistory: { event: "CHECKOUT", lamport } } },
      );
      throw err;
    }
  } catch (err) {
    next(err);
  }
};

// POST /api/circulation/return { isbn10 }: only the borrower can return, at the branch where they borrowed.
// A copy whose originBranch is elsewhere is then sent home with the transfer saga; if that branch is
// down it simply stays available here.
exports.returnBook = async (req, res, next) => {
  try {
    const isbn10 = requireIsbn(req.body);
    const { userId } = req.user;
    const lamport = await stampFor(isbn10);

    const book = await Library.findOneAndUpdate(
      { isbn10, currentBranch: env.branchId, status: "BORROWED", borrowedBy: userId },
      {
        $set: { status: "AVAILABLE", borrowedBy: null },
        $push: { custodyHistory: { event: "RETURN", branch: env.branchId, lamport, userId } },
      },
      { returnDocument: "after" },
    );
    if (!book) {
      const exists = await Library.exists({ isbn10, currentBranch: env.branchId });
      throw exists
        ? AppError.conflict(`You don't have '${isbn10}' checked out here`, "NOT_BORROWED_BY_YOU")
        : AppError.notFound(`Book '${isbn10}' is not held at branch '${env.branchId}'`, "BOOK_NOT_FOUND");
    }
    const loan = await Loan.findOneAndUpdate(
      { isbn10, userId, branch: env.branchId, status: "ACTIVE" },
      { $set: { status: "RETURNED", returnLamport: lamport } },
    );
    const late = Boolean(loan?.dueAt && loan.dueAt < new Date());

    const thanks = `Thanks for returning “${book.title}”${late ? " (it was overdue)" : ""}.`;
    let originPayload = { message: thanks };
    if (env.returnToOrigin) {
      originPayload = await sendToOrigin(book, isbn10, thanks);
    }
    res.status(200).json({ ...originPayload, late });
  } catch (err) {
    next(err);
  }
};

// POST /api/circulation/renew { isbn10 }: +LOAN_DAYS from the later of the due date and now, at most MAX_RENEWALS times.
exports.renewLoan = async (req, res, next) => {
  try {
    const isbn10 = requireIsbn(req.body);
    const { userId } = req.user;
    const loan = await Loan.findOne({ isbn10, userId, branch: env.branchId, status: "ACTIVE" });
    if (!loan) throw AppError.conflict(`You don't have '${isbn10}' checked out here`, "NOT_BORROWED_BY_YOU");
    if (loan.renewCount >= MAX_RENEWALS) {
      throw AppError.conflict(`This book has already been renewed ${MAX_RENEWALS} times. Please return it.`, "RENEW_LIMIT");
    }

    const dueAt = new Date(Date.now() + env.loanDays * 86_400_000);
    // Matching on the old dueAt means two simultaneous renewals can't both count.
    const renewed = await Loan.findOneAndUpdate(
      { _id: loan._id, status: "ACTIVE", dueAt: loan.dueAt },
      { $set: { dueAt }, $inc: { renewCount: 1 } },
      { returnDocument: "after" },
    );
    if (!renewed) throw AppError.conflict("This loan just changed, try again", "RETRY");

    const book = await Library.findOne({ isbn10, currentBranch: env.branchId }, { title: 1 }).lean();
    res.status(200).json({
      message: `Renewed “${book?.title ?? isbn10}”. It's now due ${day(dueAt)}.`,
      loan: renewed,
      renewalsLeft: MAX_RENEWALS - renewed.renewCount,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/circulation/holds/cancel { isbn10 }: release a hold; a copy from another branch is sent back there.
exports.cancelHold = async (req, res, next) => {
  try {
    const isbn10 = requireIsbn(req.body);
    const { userId } = req.user;
    const book = await Library.findOneAndUpdate(
      { isbn10, currentBranch: env.branchId, status: "ON_HOLD", heldFor: userId },
      { $set: { status: "AVAILABLE", heldFor: null, holdExpiresAt: null } },
      { returnDocument: "after" },
    );
    if (!book) {
      const exists = await Library.exists({ isbn10, currentBranch: env.branchId });
      throw exists
        ? AppError.conflict(`'${isbn10}' is not on hold for you here`, "NOT_HELD_FOR_YOU")
        : AppError.notFound(`Book '${isbn10}' is not held at branch '${env.branchId}'`, "BOOK_NOT_FOUND");
    }
    const thanks = `Your hold on “${book.title}” is cancelled.`;
    let originPayload = { message: thanks };
    if (env.returnToOrigin) {
      originPayload = await sendToOrigin(book, isbn10, thanks);
    }
    res.status(200).json({ ...originPayload, late });
  } catch (err) {
    next(err);
  }
};

// GET /api/circulation/me/books: every copy this patron has borrowed or on hold here, with its active loan.
exports.myBooks = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const [copies, loans] = await Promise.all([
      Library.find(inHandFilter(userId), { custodyHistory: 0 }).lean(),
      Loan.find({ userId, branch: env.branchId, status: "ACTIVE" }).lean(),
    ]);
    const books = copies.map((copy) => ({
      ...copy,
      loan: copy.status === "BORROWED" ? loans.find((l) => l.isbn10 === copy.isbn10) ?? null : null,
    }));
    res.status(200).json({ books, maxBooks: MAX_BOOKS, maxRenewals: MAX_RENEWALS });
  } catch (err) {
    next(err);
  }
};

// GET /api/circulation/loans/me: this user's loans at this branch, newest first (Lamport order).
exports.myLoans = async (req, res, next) => {
  try {
    const now = new Date();
    const loans = await Loan.find({ userId: req.user.userId, branch: env.branchId }).sort({ checkoutLamport: -1 }).lean();
    res.json({ loans: loans.map((l) => ({ ...l, overdue: l.status === "ACTIVE" && l.dueAt < now })) });
  } catch (err) {
    next(err);
  }
};

// GET /api/circulation/holds/me: copies waiting for this user at this branch.
exports.myHolds = async (req, res, next) => {
  try {
    const holds = await Library.find(
      { currentBranch: env.branchId, status: "ON_HOLD", heldFor: req.user.userId },
      { isbn10: 1, title: 1, holdExpiresAt: 1 },
    ).lean();
    res.json({ holds });
  } catch (err) {
    next(err);
  }
};

// GET /api/circulation/loans/overdue: librarian view of active loans past due at this branch, most overdue first.
exports.overdueLoans = async (req, res, next) => {
  try {
    const loans = await Loan.find({ branch: env.branchId, status: "ACTIVE", dueAt: { $lt: new Date() } }).sort({ dueAt: 1 }).lean();
    res.json({ loans });
  } catch (err) {
    next(err);
  }
};

// GET /api/circulation/books/:isbn10: local first, then asks every peer branch
exports.findBook = async (req, res, next) => {
  try {
    const result = await catalogSearch.findBook(req.params.isbn10);
    res.status(result.foundAt.length ? 200 : 404).json(result);
  } catch (err) {
    next(err);
  }
};

exports.getBranchCatalog = async (req, res, next) => {
  try {
    const result = await catalogSearch.getAllEntriesByBranch(req.params.branch);
    res.status(200).json({
      branch: result.branch,
      source: result.source,
      count: result.books.length,
      books: result.books,
    });
  } catch (err) {
    next(err);
  }
};