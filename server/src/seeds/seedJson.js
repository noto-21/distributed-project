// Usage: 
// $env:BRANCH_ID="ajax"; node src/seeds/seedJson.js ./data/ajax_items.csv
// Optional custom output:
// $env:BRANCH_ID="ajax"; node src/seeds/seedJson.js ./data/ajax_items.csv ./data/custom_output.json

const fs = require('node:fs');
const path = require('node:path');
const csv = require('csv-parser');
const env = require('../config/env.js'); // Gives access to branch names (oshawa, ajax, whitby)
const crypto = require('node:crypto');

const fakeObjectId = () => crypto.randomBytes(12).toString('hex');

const parseAuthors = (raw) => {
  if (!raw || !raw.trim()) return [];
  return raw.split(/[;|]/).map((a) => a.trim()).filter(Boolean);
};

const parseCsvToObjects = (filePath) => {
  return new Promise((resolve, reject) => {
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      return reject(new Error(`File not found: ${absolutePath}`));
    }

    const records = [];

    fs.createReadStream(absolutePath)
      .pipe(csv())
      .on('data', (row) => {
        records.push({
          _id: fakeObjectId(),
          isbn10: row.isbn10?.trim() || '',
          title: row.title?.trim() || '',
          subtitle: row.subtitle?.trim() || undefined,
          author: parseAuthors(row.author),
          categories: row.categories?.trim() || undefined,
          thumbnail: row.thumbnail?.trim() || undefined,
          description: row.description?.trim() || undefined,
          average_rating: Number(row.average_rating) || 0,
          ratings_count: Number(row.ratings_count) || 0,
          currentBranch: env.branchId,
          status: 'AVAILABLE',
          activeTransferId: null,
          borrowedBy: null,
          heldFor: null,
          holdExpiresAt: null,
          originBranch: env.branchId,
          custodyHistory: [],
          createdAt: "2026-11-21T18:15:00.000Z",
          updatedAt: "2026-11-21T18:15:00.000Z",
          __v: 0,
        });
      })
      .on('end', () => {
        resolve(records);
      })
      .on('error', (err) => {
        reject(err);
      });
  });
};

module.exports = parseCsvToObjects;

if (require.main === module) {
  const csvFilePath = process.argv[2];
  const customOutputPath = process.argv[3]; 

  if (!csvFilePath) {
    console.error('Usage: node src/seeds/importCsv.js <path-to-csv> [optional-output-path.json]');
    process.exit(1);
  }

  parseCsvToObjects(csvFilePath)
    .then((objects) => {
      const outputPath = customOutputPath 
        ? path.resolve(customOutputPath)
        : path.resolve(csvFilePath.replace(/\.csv$/i, '.json'));

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });

      const payload = {
        branch: env.branchId,
        source: 'local',
        count: objects.length,
        objects,
      };

      fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
      
      console.log(`Successfully saved ${objects.length} objects to ${outputPath}`);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
