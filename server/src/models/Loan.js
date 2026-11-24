// Who borrowed which copy at this branch. Stored at the branch where the checkout happened.
const mongoose = require("mongoose");
const { validBranches } = require("../config/env");

const loanSchema = new mongoose.Schema(
  {
    isbn10: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    branch: { type: String, enum: validBranches, required: true },
    status: { type: String, enum: ["ACTIVE", "RETURNED"], default: "ACTIVE" },
    checkoutLamport: { type: Number, required: true },
    dueAt: { type: Date, required: true }, // wall clock is fine: due dates are local to this branch
    returnLamport: Number,
    renewCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Loan", loanSchema);
