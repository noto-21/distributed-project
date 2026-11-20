// Public circulation API: /<branch>/api/circulation/... through NGINX
const express = require("express");
const circulationController = require("../controllers/circulationController");
const { requireAuth, requireRole } = require("../middlewares/auth");

const router = express.Router();

router.get("/books/:isbn10", circulationController.findBook);
router.post("/requests", requireAuth, circulationController.requestTransfer); // patron: bring a copy to my home branch
router.post("/checkout", requireAuth, circulationController.checkout);
router.post("/return", requireAuth, circulationController.returnBook);
router.get("/loans/me", requireAuth, circulationController.myLoans);
router.get("/holds/me", requireAuth, circulationController.myHolds);
router.get("/loans/overdue", requireAuth, requireRole("librarian"), circulationController.overdueLoans);
router.post("/transfers", requireAuth, requireRole("librarian"), circulationController.transferBook); // librarian push

module.exports = router;
