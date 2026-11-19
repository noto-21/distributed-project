// Pings each branch's Atlas cluster once. Run: npm run check:db
const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({
  path: [path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../../../.env')],
  quiet: true,
});

const BRANCHES = ['ajax', 'oshawa', 'whitby'];

async function check(branch) {
  const uri = process.env[`MONGO_URI_${branch.toUpperCase()}`];
  if (!uri) return { branch, ok: false, detail: `MONGO_URI_${branch.toUpperCase()} not set` };

  const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await conn.asPromise();
    await conn.db.admin().ping();
    return { branch, ok: true, detail: `${conn.host} / db "${conn.name}"` };
  } catch (err) {
    return { branch, ok: false, detail: err.message };
  } finally {
    await conn.close().catch(() => {});
  }
}

(async () => {
  const results = await Promise.all(BRANCHES.map(check));
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.branch.padEnd(7)} ${r.detail}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})();
