// Handles HTTP requests to send book from one library to another
// Library-to-Library / Server-to-Server
const transferSaga = require("../services/transferSaga");
const catalogSearch = require("../services/catalogSearch");
const AppError = require("../utils/AppError");

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

// GET /api/circulation/books/:isbn10 — local first, then asks every peer branch
exports.findBook = async (req, res, next) => {
  try {
    const result = await catalogSearch.findBook(req.params.isbn10);
    res.status(result.foundAt.length ? 200 : 404).json(result);
  } catch (err) {
    next(err);
  }
};
