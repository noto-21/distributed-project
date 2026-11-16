// Stateless JWT auth: any replica of any branch can verify a token because they share JWT_SECRET.
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const signToken = (user) => jwt.sign(
  { userId: String(user._id), role: user.role, homeBranch: user.homeBranch },
  env.jwtSecret,
  { expiresIn: env.jwtExpiresIn },
);

function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    req.user = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Use after requireAuth, e.g. router.post('/books', requireAuth, requireRole('librarian'), ...)
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Forbidden' });

module.exports = { signToken, requireAuth, requireRole };
