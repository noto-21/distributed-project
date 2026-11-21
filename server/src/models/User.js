const mongoose = require("mongoose");
const { validBranches } = require("../config/env");

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, trim: true },
    passwordHash: String,
    googleId: { type: String, unique: true, sparse: true },
    role: { type: String, enum: ["patron", "librarian"], default: "patron" },
    homeBranch: { type: String, enum: validBranches, required: true },
    // Order of creation across branches without trusting wall clocks: (createdLamport, homeBranch).
    createdLamport: { type: Number, default: 0 },
    // Set when another branch turned out to hold the same email first; this account is then ignored.
    duplicateOf: { type: String, enum: [...validBranches, null], default: null },
    book: { type: String, trim: true, default: "" },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

module.exports = mongoose.model("User", userSchema);
