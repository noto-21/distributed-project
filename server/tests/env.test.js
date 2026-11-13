// env.js validates at require time, so give it a valid branch before loading.
process.env.BRANCH_ID = 'ajax';
process.env.MONGO_URI = 'mongodb://localhost:27017/library_test';
const { loadEnv, parsePeerUrls } = require('../src/config/env');

const base = { BRANCH_ID: 'ajax', MONGO_URI: 'mongodb://x/db' };

test('parses PEER_URLS and drops self', () => {
  expect(parsePeerUrls('ajax=http://a:3000, oshawa=http://o:3000,whitby=http://w:3000', 'ajax'))
    .toEqual({ oshawa: 'http://o:3000', whitby: 'http://w:3000' });
});

test('rejects unknown or malformed peer entries', () => {
  expect(() => parsePeerUrls('pickering=http://p:3000', 'ajax')).toThrow(/Invalid PEER_URLS/);
  expect(() => parsePeerUrls('oshawa', 'ajax')).toThrow(/Invalid PEER_URLS/);
});

test('BRANCH_ID is required, validated, and case-insensitive', () => {
  expect(() => loadEnv({ ...base, BRANCH_ID: undefined })).toThrow(/BRANCH_ID/);
  expect(() => loadEnv({ ...base, BRANCH_ID: 'toronto' })).toThrow(/BRANCH_ID/);
  expect(loadEnv({ ...base, BRANCH_ID: 'OSHAWA' }).branchId).toBe('oshawa');
});

test('falls back to MONGO_URI_<BRANCH>, and fails when neither is set', () => {
  expect(loadEnv({ BRANCH_ID: 'whitby', MONGO_URI_WHITBY: 'mongodb://w/db' }).mongoUri).toBe('mongodb://w/db');
  expect(() => loadEnv({ BRANCH_ID: 'whitby' })).toThrow(/MONGO_URI/);
});

test('JWT_SECRET is required in production only', () => {
  expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
  expect(loadEnv(base).jwtSecret).toBeTruthy();
});
