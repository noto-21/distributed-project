// $env:BRANCH_ID='ajax'; npm test -- tests/inspectData.test.js
// this is a bad test fix this
const mongoose = require("mongoose");
const env = require("../src/config/env.js");
const Library = require("../src/models/Library.js");

const printLibraryData = async () => {
  try {
    await mongoose.connect(env.mongoUri);
    console.log(`[${env.branchId}] connected to MongoDB`);

    const libraryRecords = await Library.find({}).lean();

    console.log(`Found ${libraryRecords.length} records:`);

    // console.log(JSON.stringify(libraryRecords, null, 2));
    // Loop through and print the title of each row
    libraryRecords.forEach((record, index) => {
      console.log(`${index + 1}. ${record.title || "Untitled"}`);
    });
  } catch (error) {
    console.error("Error fetching library data:", error);
  } finally {
    await mongoose.connection.close();
    console.log("Database connection closed.");
  }
};

describe("Library Database Inspection", () => {
  it("prints all current records across collections", async () => {
    await printLibraryData();
  });
});
