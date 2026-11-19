// Router used for secure server-to-server communication between peer branches in a distributed system
const express = require("express");
const env = require("../config/env");
const lamportClock = require("../utils/lamportClock");
const internalController = require("../controllers/internalController");
const AppError = require("../utils/AppError");

const router = express.Router();

// Authenticate peer branch requests using INTERNAL_API_SECRET
router.use((req, res, next) => {
  const token = req.headers["x-internal-secret"];
  if (!token || token !== env.internalSecret) {
    return next(AppError.forbidden("Invalid internal API secret", "INVALID_INTERNAL_SECRET"));
  }
  next();
});

// Used by discoveryService.probePeer() heartbeats
router.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    branchId: env.branchId,
    lamportClock: lamportClock.now(),
  });
});

// Used by transferSaga to receive a transferred Library row
router.post("/transfers/receive", internalController.receiveTransfer);

// Used by catalogSearch when a peer has a local miss
router.get("/books/:isbn10", internalController.lookupBook);

module.exports = router;
