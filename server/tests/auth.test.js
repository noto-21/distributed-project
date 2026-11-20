// Auth routes against a mocked User model, so no DB is needed (same as CI).
process.env.BRANCH_ID = 'ajax';
process.env.MONGO_URI = 'mongodb://localhost:27017/library_test';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

jest.mock('../src/models/User', () => ({ create: jest.fn(), findOne: jest.fn(), findById: jest.fn(), exists: jest.fn() }));
jest.mock('../src/models/RefreshToken', () => ({ create: jest.fn(async () => ({})), findOneAndUpdate: jest.fn(), findOne: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn() }));


const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = require('../src/server');
const User = require('../src/models/User');
const env = require('../src/config/env');
const { signToken, requireRole } = require('../src/middlewares/auth');

const fakeUser = (over = {}) => ({ _id: 'u1', email: 'a@b.co', role: 'patron', homeBranch: 'ajax', ...over });

const RefreshToken = require('../src/models/RefreshToken');
beforeEach(() => { jest.resetAllMocks(); RefreshToken.create.mockResolvedValue({}); });

test('register hashes the password, forces patron role and returns a valid JWT', async () => {
  User.create.mockImplementation(async (doc) => fakeUser(doc));
  const res = await request(app).post('/api/auth/register')
    .send({ email: 'a@b.co', password: 'password123', role: 'librarian', homeBranch: 'ajax' });

  expect(res.status).toBe(201);
  const doc = User.create.mock.calls[0][0];
  expect(doc.role).toBeUndefined();
  expect(doc.homeBranch).toBe('ajax');
  expect(await bcrypt.compare('password123', doc.passwordHash)).toBe(true);
  expect(jwt.verify(res.body.token, env.jwtSecret)).toMatchObject({ userId: 'u1', role: 'patron', homeBranch: 'ajax' });
});

test('register validates input and reports duplicate email', async () => {
  const reg = (body) => request(app).post('/api/auth/register').send({ homeBranch: 'ajax', ...body });
  expect((await reg({ email: 'bad', password: 'password123' })).status).toBe(400);
  expect((await reg({ email: 'a@b.co', password: 'short' })).status).toBe(400);
  expect((await reg({ email: 'a@b.co', password: 'password123', homeBranch: undefined })).body.code).toBe('INVALID_HOME_BRANCH');
  expect((await reg({ email: 'a@b.co', password: 'password123', homeBranch: 'toronto' })).status).toBe(400);
  User.exists.mockResolvedValue(true); // already registered at this branch
  expect((await reg({ email: 'a@b.co', password: 'password123' })).body.code).toBe('EMAIL_TAKEN');
  User.exists.mockResolvedValue(null);
  User.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 })); // lost a race to the unique index
  expect((await reg({ email: 'a@b.co', password: 'password123' })).status).toBe(409);
});

test('login accepts the right password and rejects wrong / Google-only accounts', async () => {
  User.findOne.mockResolvedValue(fakeUser({ passwordHash: await bcrypt.hash('password123', 4) }));
  expect((await request(app).post('/api/auth/login').send({ email: 'A@B.co', password: 'password123' })).status).toBe(200);
  expect(User.findOne).toHaveBeenCalledWith({ email: 'a@b.co', duplicateOf: null });
  expect((await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: 'nope' })).status).toBe(401);

  User.findOne.mockResolvedValue(fakeUser({ googleId: 'g1' }));
  expect((await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: 'x' })).status).toBe(401);
});

test('/me requires a valid, unexpired token', async () => {
  User.findById.mockResolvedValue(fakeUser());
  expect((await request(app).get('/api/auth/me')).body).toMatchObject({ code: 'UNAUTHORIZED' });
  expect((await request(app).get('/api/auth/me').set('Authorization', 'Bearer garbage')).body.code).toBe('TOKEN_INVALID');
  const expired = jwt.sign({ userId: 'u1' }, env.jwtSecret, { expiresIn: -1 });
  const exp = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`);
  expect(exp.status).toBe(401);
  expect(exp.body.code).toBe('TOKEN_EXPIRED'); // the client's cue to call /api/auth/refresh
  const forged = jwt.sign({ userId: 'u1' }, 'wrong-secret');
  expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);

  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${signToken(fakeUser())}`);
  expect(res.status).toBe(200);
  expect(User.findById).toHaveBeenCalledWith('u1');
});

test('requireRole blocks other roles', () => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  requireRole('librarian')({ user: { role: 'patron' } }, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  requireRole('librarian')({ user: { role: 'librarian' } }, res, next);
  expect(next).toHaveBeenCalled();
});

describe('Google OAuth', () => {
  afterEach(() => { delete global.fetch; });

  test('start redirects to Google with a state cookie', async () => {
    const res = await request(app).get('/api/auth/google');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.host).toBe('accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8090/ajax/api/auth/google/callback');
    expect(res.headers['set-cookie'][0]).toContain(`oauth_state=${url.searchParams.get('state')}`);
  });

  test('callback rejects a missing or mismatched state', async () => {
    expect((await request(app).get('/api/auth/google/callback?code=c&state=s')).status).toBe(400);
    expect((await request(app).get('/api/auth/google/callback?code=c&state=s').set('Cookie', 'oauth_state=other')).status).toBe(400);
  });

  test('callback creates the user at this branch and redirects with a JWT', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'at' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: 'g1', email: 'New@b.co', email_verified: true, name: 'N' }) });
    User.findOne.mockResolvedValue(null);
    User.create.mockImplementation(async (doc) => fakeUser({ _id: 'u2', ...doc }));

    const res = await request(app).get('/api/auth/google/callback?code=c&state=s').set('Cookie', 'oauth_state=s');

    expect(res.status).toBe(302);
    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({ googleId: 'g1', homeBranch: 'ajax' }));
    expect(res.headers.location.startsWith(`${env.clientUrl}/auth/callback#token=`)).toBe(true);
    const fragment = new URLSearchParams(res.headers.location.split('#')[1]);
    expect(jwt.verify(fragment.get('token'), env.jwtSecret).userId).toBe('u2');
    expect(fragment.get('refreshToken')).toMatch(/^ajax./); // stored at the user's home branch
  });

  test('callback refuses unverified Google emails', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'at' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sub: 'g1', email: 'a@b.co', email_verified: false }) });
    const res = await request(app).get('/api/auth/google/callback?code=c&state=s').set('Cookie', 'oauth_state=s');
    expect(res.status).toBe(403);
    expect(User.create).not.toHaveBeenCalled();
  });
});
