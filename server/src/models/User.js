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
