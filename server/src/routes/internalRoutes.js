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

// Transfer saga: receive a copy; send one on a peer's request; report a saga's outcome (crash recovery)
router.post("/transfers/receive", internalController.receiveTransfer);
router.post("/transfers/send", internalController.sendTransfer);
router.get("/transfers/:sagaId", internalController.transferStatus);

// Used by catalogSearch when a peer has a local miss
router.get("/books/:isbn10", internalController.lookupBook);

// Users live at their home branch; other branches create, verify and read them through these
router.get("/users/exists", internalController.userExists);
router.post("/users/lookup", internalController.lookupUsers);
router.post("/users/verify", internalController.verifyUser);
router.post("/users", internalController.createUser);
router.get("/users/:id", internalController.getUser);

// Refresh tokens are stored at the user's home branch; other branches forward refresh/logout here
router.post("/auth/refresh", internalController.refreshToken);
router.post("/auth/logout", internalController.logoutToken);

router.get("/books", internalController.listBooks);

module.exports = router;
