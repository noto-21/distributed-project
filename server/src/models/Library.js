const mongoose = require("mongoose");
const { validBranches } = require("../config/env");

const librarySchema = new mongoose.Schema(
  {
    isbn10: { type: String, required: true, unique: true, trim: true, index: true },
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, trim: true },
    author: { type: [String], default: [], index: true },
    categories: { type: String, trim: true },
    thumbnail: { type: String, trim: true },
    description: { type: String, trim: true },
    average_rating: { type: Number, min: 0, max: 5, default: 0 },
    num_pages: { type: Number, min: 0 },
    ratings_count: { type: Number, min: 0, default: 0 },
    currentBranch: { type: String, enum: validBranches, required: true },
    status: {
      type: String,
      enum: ["AVAILABLE", "BORROWED", "IN_TRANSIT", "ON_HOLD"],
      default: "AVAILABLE",
    },
    activeTransferId: { type: String, default: null },
    borrowedBy: { type: String, default: null }, // userId from the JWT while status is BORROWED
    // ON_HOLD: reserved for the patron who requested it, until holdExpiresAt (this branch's clock).
    heldFor: { type: String, default: null },
    holdExpiresAt: { type: Date, default: null },
    // Branch that owns this copy: a return anywhere else routes it back here. Travels with the copy on transfer.
    originBranch: { type: String, enum: validBranches },
    // Every hand-off of this copy, ordered by Lamport time (wall clocks differ between branches).
    custodyHistory: {
      type: [
        {
          _id: false,
          event: { type: String, enum: ["CHECKOUT", "RETURN", "TRANSFER_IN"], required: true },
          branch: { type: String, enum: validBranches, required: true },
          lamport: { type: Number, required: true },
          userId: String,
          from: { type: String, enum: validBranches },
        },
      ],
      default: [],
    },
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

// A copy first saved at a branch belongs to that branch.
librarySchema.pre("validate", function setOrigin() {
  if (!this.originBranch) this.originBranch = this.currentBranch;
});

module.exports = mongoose.model("Library", librarySchema);
