// Refresh tokens live at the user's home branch. Only a SHA-256 hash is stored, so a DB leak can't be replayed.
const mongoose = require("mongoose");

const refreshTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }, // Mongo deletes it once expired
    revokedAt: { type: Date, default: null },
    replacedBy: { type: String, default: null }, // hash of the token issued when this one was rotated
  },
  { timestamps: true },
);

module.exports = mongoose.model("RefreshToken", refreshTokenSchema);
