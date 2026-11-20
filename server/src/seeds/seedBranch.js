//  $env:BRANCH_ID='ajax'; npm run seed ./data/ajax_items.csv
const mongoose = require("mongoose");
const fs = require("node:fs");
const path = require("node:path");
const csv = require("csv-parser");

// Reuse your existing config and models
const env = require("../config/env.js"); // Gives access to the database URI and the branch names (oshawa, ajax, whitby)
const Library = require("../models/Library.js"); // Library model (schema)

const importCsv = async (filePath) => {
  const absolutePath = path.resolve(filePath); // Make sure to add the path to the csv (./data/ajax_items.csv)

  if (!fs.existsSync(absolutePath)) {
    console.error(`File not found: ${absolutePath}`); // otherwise it'll fail
    process.exit(1);
  }

  try {
    // Connects to the specific branch DB defined by your .env / Docker container
    await mongoose.connect(env.mongoUri);
    console.log(`[${env.branchId}] connected to MongoDB`);

    const records = [];

    fs.createReadStream(absolutePath)
      .pipe(csv())
      .on("data", (row) => {
        // insert each column into records
        records.push({
          isbn10: row.isbn10,
          title: row.title,
          subtitle: row.subtitle,
          author: row.author,
          categories: row.categories,
          thumbnail: row.thumbnail,
          description: row.description,
          average_rating: Number(row.average_rating),
          ratings_count: Number(row.ratings_count),
          currentBranch: env.branchId, // Whatever branch we're currently on (might be redundant)
          status: "AVAILABLE",
          activeTransferId: null,
          borrowedBy: null,
          heldFor: null,
          holdExpiresAt: null,
          originBranch: env.branchId,
          custodyHistory: [],
        });
      })
      .on("end", async () => {
        try {
          if (records.length > 0) {
            const result = await Library.insertMany(records, { ordered: false }); // push them all into mongo Library
            console.log(`Successfully imported ${result.length} records.`);
          } else {
            console.log("CSV file was empty.");
          }
        } catch (insertError) {
          console.warn("Completed with some errors (e.g., duplicate keys):", insertError.message);
        } finally {
          await mongoose.connection.close();
          process.exit(0);
        }
      });
  } catch (err) {
    console.error("Database connection failed:", err);
    process.exit(1);
  }
};

// Grab the CSV path from the arguments
const csvFilePath = process.argv[2];
if (!csvFilePath) {
  console.error("Usage: node src/seeds/importCsv.js <path-to-csv>");
  process.exit(1);
}

importCsv(csvFilePath);
