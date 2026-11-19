const express = require("express");
const auth = require("../controllers/authController");
const { requireAuth } = require("../middlewares/auth");

const router = express.Router();

router.post("/register", auth.register);
router.post("/login", auth.login);
router.get("/me", requireAuth, auth.me);
router.get("/google", auth.googleStart);
router.get("/google/callback", auth.googleCallback);

module.exports = router;
