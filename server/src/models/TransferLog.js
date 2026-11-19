const mongoose = require("mongoose");
const { validBranches } = require("../config/env");

const transferLogSchema = new mongoose.Schema(
  {
    sagaId: { type: String, required: true, unique: true, index: true },
    bookIsbn: { type: String, required: true },
    sourceBranch: { type: String, enum: validBranches, required: true },
    targetBranch: { type: String, enum: validBranches, required: true },
    status: {
      type: String,
      enum: ["PENDING", "RESERVED", "COMMITTED", "COMPENSATING", "FAILED", "ROLLED_BACK"],
      default: "PENDING",
    },
    lamportTimestamp: { type: Number, required: true },
    errorReason: { type: String },
  },
  { timestamps: true },
);

module.exports = mongoose.model("TransferLog", transferLogSchema);
