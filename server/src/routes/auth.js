const express = require("express");
const auth = require("../controllers/authController");
const { requireAuth } = require("../middlewares/auth");
const { routeToHome } = require("../middlewares/homeRouter");
const { rateLimit } = require("../middlewares/security");
const env = require("../config/env");

const router = express.Router();

// Per-IP limits slow down password guessing and signup spam.
router.post("/register", rateLimit({ name: "register", max: env.authRateLimit }), auth.register);
router.post("/login", rateLimit({ name: "login", max: env.authRateLimit }), auth.login);
router.post("/refresh", rateLimit({ name: "refresh", max: env.authRateLimit * 3 }), auth.refresh);
router.post("/logout", auth.logout);
router.get("/me", requireAuth, routeToHome, auth.me);
router.get("/google", auth.googleStart);
router.get("/google/callback", auth.googleCallback);

module.exports = router;
