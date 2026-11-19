// Router that sets up a POST API endpoint at /transfers to handle book transfers
const express = require("express");
const circulationController = require("../controllers/circulationController");
const { requireAuth } = require("../middlewares/auth");

const router = express.Router();

// Remove requireAuth temporarily if you wanna test curl without a JWT token first
//router.post("/transfers", requireAuth, circulationController.transferBook);
router.post("/transfers", circulationController.transferBook);
router.get("/books/:isbn10", circulationController.findBook);
router.post("/checkout", requireAuth, circulationController.checkout);

module.exports = router;
