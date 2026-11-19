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
      enum: ["AVAILABLE", "BORROWED", "IN_TRANSIT"],
      default: "AVAILABLE",
    },
    activeTransferId: { type: String, default: null },
    borrowedBy: { type: String, default: null }, // userId from the JWT while status is BORROWED
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

module.exports = mongoose.model("Library", librarySchema);
