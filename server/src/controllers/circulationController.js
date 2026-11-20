// Patron and librarian circulation: search, request-to-home-branch, checkout, return, loans, manual transfers.
const transferSaga = require("../services/transferSaga");
const catalogSearch = require("../services/catalogSearch");
const { callPeer } = require("../services/peerClient");
const lamportClock = require("../utils/lamportClock");
const AppError = require("../utils/AppError");
const Library = require("../models/Library");
const Loan = require("../models/Loan");
const env = require("../config/env");

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

    const search = await catalogSearch.findBook(isbn10);
    if (search.source === "local") {
      return res.status(200).json({ status: "AVAILABLE_HERE", branch: home, book: search.foundAt[0].book });
    }

    const offline = [...search.offline];
    let lostRace = false;
    for (const { branch } of search.foundAt) {
      try {
        const { status, body } = await callPeer(branch, "POST", "/transfers/send", { isbn10, targetBranch: home });
        if (status === 200) return res.status(200).json({ status: "TRANSFERRED", from: branch, to: home, transfer: body.transfer });
        if (status === 409) lostRace = true;
      } catch {
        offline.push(branch);
      }
    }

    const warning = offline.length ? `Branch(es) unreachable: ${offline.join(", ")}.` : undefined;
    if (lostRace) throw AppError.conflict("Every available copy was taken or is already moving", "BOOK_UNAVAILABLE", { offline, warning });
    res.status(404).json({ error: `No branch can send '${isbn10}' right now`, code: "BOOK_NOT_FOUND", offline, warning });
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
    const lamport = await stampFor(isbn10);

    const book = await Library.findOneAndUpdate(
      { isbn10, currentBranch: env.branchId, status: "AVAILABLE", activeTransferId: null },
      {
        $set: { status: "BORROWED", borrowedBy: userId },
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
      const loan = await Loan.create({ isbn10, userId, branch: env.branchId, checkoutLamport: lamport });
      res.status(200).json({ message: "Book checked out", book, loan });
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
    await Loan.updateOne({ isbn10, userId, branch: env.branchId, status: "ACTIVE" }, { $set: { status: "RETURNED", returnLamport: lamport } });

    const origin = book.originBranch;
    if (!origin || origin === env.branchId) return res.status(200).json({ message: "Book returned", book, routedTo: null });

    try {
      const transfer = await transferSaga.executeTransfer({ isbn10, targetBranch: origin });
      res.status(200).json({ message: `Book returned and sent home to ${origin}`, routedTo: origin, transfer });
    } catch (err) {
      res.status(200).json({
        message: "Book returned",
        book,
        routedTo: null,
        warning: `Could not send it home to ${origin} yet (${err.message}); it stays available here.`,
      });
    }
  } catch (err) {
    next(err);
  }
};

// GET /api/circulation/loans/me: this user's loans at this branch, newest first (Lamport order).
exports.myLoans = async (req, res, next) => {
  try {
    const loans = await Loan.find({ userId: req.user.userId, branch: env.branchId }).sort({ checkoutLamport: -1 }).lean();
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
