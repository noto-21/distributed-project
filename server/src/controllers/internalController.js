// Controller for library receiving book from library and marking event in TransferLog
const Library = require("../models/Library");
const TransferLog = require("../models/TransferLog");
const lamportClock = require("../utils/lamportClock");
const discoveryService = require("../services/discoveryService");

exports.receiveTransfer = async (req, res, next) => {
  try {
    // Transfer ID, where the book came from, book details
    const { sagaId, sourceBranch, bookData } = req.body;
    const targetBranch = discoveryService.selfBranch; // Identify the current server branch

    // Idempotency check: If this sagaId was already committed, return 200 OK immediately
    const existingLog = await TransferLog.findOne({ sagaId });
    if (existingLog && existingLog.status === "COMMITTED") {
      res.set("x-lamport-timestamp", String(lamportClock.tick()));
      return res.status(200).json({ message: "Transfer already applied", sagaId }); // Duplicate prevention
    }

    // Insert the transferred book into the target branch Library
    const createdBook = await Library.create({
      ...bookData,
      currentBranch: targetBranch,
      status: "AVAILABLE",
      activeTransferId: null,
    });

    const tick = lamportClock.tick(); // +1 to the event counter
    // Add transfer to records
    await TransferLog.findOneAndUpdate(
      { sagaId },
      {
        sagaId,
        bookIsbn: bookData.isbn10,
        sourceBranch,
        targetBranch,
        status: "COMMITTED",
        lamportTimestamp: tick,
      },
      { upsert: true },
    );

    res.set("x-lamport-timestamp", String(tick));
    res.status(201).json({ message: "Row transferred successfully", book: createdBook });
  } catch (err) {
    next(err);
  }
};
