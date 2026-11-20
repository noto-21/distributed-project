// Stateless JWT auth: any replica of any branch can verify a token because they share JWT_SECRET.
const jwt = require("jsonwebtoken");
const env = require("../config/env");

const signToken = (user) =>
  jwt.sign(
    { userId: String(user._id), role: user.role, homeBranch: user.homeBranch },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );

function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || "").split(" ");
  if (scheme !== "Bearer" || !token) return res.status(401).json({ error: "Missing bearer token", code: "UNAUTHORIZED" });
  try {
    req.user = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
    next();
  } catch (err) {
    // TOKEN_EXPIRED tells the client to call /api/auth/refresh; TOKEN_INVALID means log in again.
    const expired = err.name === "TokenExpiredError";
    res.status(401).json({ error: expired ? "Access token expired" : "Invalid token", code: expired ? "TOKEN_EXPIRED" : "TOKEN_INVALID" });
  }
}

// For routes that work signed out too (search): reads a valid token if present, never rejects.
function optionalAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || "").split(" ");
  if (scheme === "Bearer" && token) {
    try {
      req.user = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
    } catch {
      /* treat a bad or expired token as signed out */
    }
  }
  next();
}

// Use after requireAuth, e.g. router.post('/books', requireAuth, requireRole('librarian'), ...)
const requireRole =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.user?.role) ? next() : res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });

module.exports = { signToken, requireAuth, optionalAuth, requireRole };
