// Handles HTTP requests to send book from one library to another
// Library-to-Library / Server-to-Server
const transferSaga = require("../services/transferSaga");
const catalogSearch = require("../services/catalogSearch");
const AppError = require("../utils/AppError");
const Library = require("../models/Library");
const env = require("../config/env");

exports.transferBook = async (req, res, next) => {
  try {
    // request comes with the isbn10 id and the branch it's being sent to
    const { isbn10, targetBranch } = req.body;

    if (!isbn10 || !targetBranch) {
      return next(AppError.badRequest("isbn10 and targetBranch are required"));
    }

    const result = await transferSaga.executeTransfer({ isbn10, targetBranch });

    res.status(200).json({
      message: "Book transferred successfully",
      transfer: result,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/circulation/checkout { isbn10 } — borrow a copy held at this branch.
// One atomic conditional update: of N simultaneous requests only one can match status AVAILABLE,
// and a copy locked by a transfer (activeTransferId set) can't be borrowed mid-flight.
exports.checkout = async (req, res, next) => {
  try {
    const { isbn10 } = req.body || {};
    if (typeof isbn10 !== "string" || !isbn10) return next(AppError.badRequest("isbn10 is required"));

    const book = await Library.findOneAndUpdate(
      { isbn10, currentBranch: env.branchId, status: "AVAILABLE", activeTransferId: null },
      { $set: { status: "BORROWED", borrowedBy: req.user.userId } },
      { returnDocument: "after" },
    );
    if (book) return res.status(200).json({ message: "Book checked out", book });

    // Lost the race or never here: tell the two apart for the caller.
    const exists = await Library.exists({ isbn10, currentBranch: env.branchId });
    next(exists
      ? AppError.conflict(`Book '${isbn10}' is not available for checkout`, "BOOK_UNAVAILABLE")
      : AppError.notFound(`Book '${isbn10}' is not held at branch '${env.branchId}'`, "BOOK_NOT_FOUND"));
  } catch (err) {
    next(err);
  }
};

// GET /api/circulation/books/:isbn10 — local first, then asks every peer branch
exports.findBook = async (req, res, next) => {
  try {
    const result = await catalogSearch.findBook(req.params.isbn10);
    res.status(result.foundAt.length ? 200 : 404).json(result);
  } catch (err) {
    next(err);
  }
};
