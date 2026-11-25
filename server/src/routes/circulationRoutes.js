// Public circulation API: /<branch>/api/circulation/... through NGINX
const express = require("express");
const circulationController = require("../controllers/circulationController");
const { requireAuth, optionalAuth, requireRole } = require("../middlewares/auth");
const { routeToHome } = require("../middlewares/homeRouter");

const router = express.Router();

// Signed-in requests always run at the user's home branch (routeToHome forwards them if NGINX picked another).
// Search works signed out too; signed in, it starts from the home branch's shelf.
const home = [requireAuth, routeToHome];
router.get("/books/:isbn10", optionalAuth, routeToHome, circulationController.findBook);
// :branch is where its going to
router.get("/branches/:branch/books", optionalAuth, circulationController.getBranchCatalog);

router.post("/requests", ...home, circulationController.requestTransfer); // patron: bring a copy to my branch
router.post("/checkout", ...home, circulationController.checkout);
router.post("/return", ...home, circulationController.returnBook);
router.get("/loans/me", ...home, circulationController.myLoans);
router.get("/holds/me", ...home, circulationController.myHolds);
router.get("/me/books", ...home, circulationController.myBooks); // My Books page: borrowed + held copies with loans
router.post("/renew", ...home, circulationController.renewLoan);
router.post("/holds/cancel", ...home, circulationController.cancelHold);
router.get("/loans/overdue", ...home, requireRole("librarian"), circulationController.overdueLoans); // librarian's own branch
router.post("/transfers", ...home, requireRole("librarian"), circulationController.transferBook); // librarian push


module.exports = router;
