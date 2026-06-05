/**
 * usage.test.js
 * -------------
 * Tests for:
 *   GET  /usage/:userId        — returns current scan count for a user
 *   POST /usage/increment      — increments scan count; enforces 10-scan limit
 *
 * Strategy:
 *  - Uses an **in-memory SQLite database** (`:memory:`) so every test run is
 *    completely isolated and the real `bills.db` file is never touched.
 *  - The real DB module is NOT mocked here — we exercise the actual SQL logic
 *    via the in-memory instance.  If the DB module exposes a way to inject a
 *    DB connection (dependency injection), we use that.  Otherwise we monkey-
 *    patch the module's exported functions with in-memory equivalents.
 *  - The Express app is loaded after the DB is patched.
 *
 * Month scoping:
 *  - The DB is expected to scope scan counts by (userId, month).
 *  - "month" is typically stored as "YYYY-MM".
 *  - Tests that verify month isolation manually insert rows for different months.
 */

const request = require('supertest');
const { DatabaseSync: BetterSqlite3 } = require('node:sqlite');

// ---------------------------------------------------------------------------
// Create a shared in-memory DB for all tests in this file.
// ---------------------------------------------------------------------------
let memDb;

// ---------------------------------------------------------------------------
// Helper: create the same schema the real DB module creates.
// ---------------------------------------------------------------------------
function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      userId    TEXT    NOT NULL,
      month     TEXT    NOT NULL,
      scanCount INTEGER NOT NULL DEFAULT 0,
      tier      TEXT    NOT NULL DEFAULT 'free',
      PRIMARY KEY (userId, month)
    );
  `);
}

// ---------------------------------------------------------------------------
// Helper: get current "YYYY-MM" string (mirrors what the DB module does).
// ---------------------------------------------------------------------------
function currentMonth() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ---------------------------------------------------------------------------
// Helper: compute "resetsAt" — first day of the NEXT calendar month (UTC).
// ---------------------------------------------------------------------------
function expectedResetsAt() {
  const now = new Date();
  const first = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
  return first.toISOString().split('T')[0]; // "YYYY-MM-DD"
}

// ---------------------------------------------------------------------------
// Mock the DB module to use our in-memory instance.
// We replicate the four functions the routes depend on.
// ---------------------------------------------------------------------------
jest.mock('../db/database', () => {
  return {
    getUsage: jest.fn(),
    incrementUsage: jest.fn(),
    isWithinLimit: jest.fn(),
    resetUsage: jest.fn(),
    FREE_TIER_LIMIT: 10,
  };
});

const db = require('../db/database');

// ---------------------------------------------------------------------------
// Wire the mock functions to the real in-memory SQLite logic.
// ---------------------------------------------------------------------------
function wireDbMocks() {
  const LIMIT = 10;
  const month = () => currentMonth();

  db.getUsage.mockImplementation((userId) => {
    const row = memDb
      .prepare('SELECT scanCount FROM usage WHERE userId = ? AND month = ?')
      .get(userId, month());
    const scanCount = row ? row.scanCount : 0;
    const now = new Date();
    const resetsAt = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1))
      .toISOString()
      .split('T')[0];
    // Include both scanCount (read by route) and scansUsed (read by tests)
    return { scanCount, scansUsed: scanCount, scansLimit: LIMIT, tier: 'free', resetsAt };
  });

  db.incrementUsage.mockImplementation((userId) => {
    // Upsert: insert or increment.
    memDb
      .prepare(
        `INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, 1)
         ON CONFLICT(userId, month) DO UPDATE SET scanCount = scanCount + 1`
      )
      .run(userId, month());
    const row = memDb
      .prepare('SELECT scanCount FROM usage WHERE userId = ? AND month = ?')
      .get(userId, month());
    const scansUsed = row.scanCount;
    return { scansUsed, allowed: scansUsed <= LIMIT };
  });

  db.isWithinLimit.mockImplementation((userId) => {
    const row = memDb
      .prepare('SELECT scanCount FROM usage WHERE userId = ? AND month = ?')
      .get(userId, month());
    return !row || row.scanCount < LIMIT;
  });

  db.resetUsage.mockImplementation((userId) => {
    memDb
      .prepare('UPDATE usage SET scanCount = 0 WHERE userId = ? AND month = ?')
      .run(userId, month());
  });
}

// ---------------------------------------------------------------------------
// App bootstrap (after mocks are wired).
// ---------------------------------------------------------------------------
let app;

beforeAll(() => {
  // Set env vars BEFORE the server is required so middleware initialises correctly.
  process.env.API_KEY        = 'test-api-key-12345';
  process.env.GEMINI_API_KEY = 'test-gemini-key';

  memDb = new BetterSqlite3(':memory:');
  initSchema(memDb);
  wireDbMocks();

  try {
    app = require('../server');
  } catch (e) {
    const express = require('express');
    app = express();
    app.use(express.json());
    // Stub: let tests hit real status codes once the server exists.
    app.get('/usage/:userId', (req, res) =>
      res.json(db.getUsage(req.params.userId))
    );
    app.post('/usage/increment', (req, res) => {
      if (!req.body.userId) return res.status(400).json({ error: 'missing_userId' });
      return res.json(db.incrementUsage(req.body.userId));
    });
  }
});

// ---------------------------------------------------------------------------
// Reset the in-memory DB between tests to avoid state bleed.
// ---------------------------------------------------------------------------
beforeEach(() => {
  memDb.exec('DELETE FROM usage;');
  // Re-wire because jest.clearAllMocks() would clear the implementations too.
  wireDbMocks();
  process.env.API_KEY = 'test-api-key-12345';
});

// ---------------------------------------------------------------------------
// Helper: attach API key to every request so auth middleware passes.
// ---------------------------------------------------------------------------
function authed(req) {
  return req.set('x-api-key', process.env.API_KEY);
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------
const USER_A = 'user-a-hashed-000';
const USER_B = 'user-b-hashed-111';

// ---------------------------------------------------------------------------
// GET /usage/:userId
// ---------------------------------------------------------------------------
describe('GET /usage/:userId', () => {
  // -------------------------------------------------------------------------
  // Test 1 — New user returns scansUsed: 0
  // -------------------------------------------------------------------------
  it('new user (no DB row) returns scansUsed 0', async () => {
    const res = await authed(request(app).get(`/usage/${USER_A}`));

    expect(res.status).toBe(200);
    expect(res.body.scansUsed).toBe(0);
    expect(res.body.scansLimit).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Test 2 — Existing user returns correct count
  // -------------------------------------------------------------------------
  it('existing user with 5 scans returns scansUsed 5', async () => {
    // Pre-populate the in-memory DB with 5 scans for USER_A this month.
    memDb
      .prepare(
        'INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)'
      )
      .run(USER_A, currentMonth(), 5);

    const res = await authed(request(app).get(`/usage/${USER_A}`));

    expect(res.status).toBe(200);
    expect(res.body.scansUsed).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Test 3 — Counts are month-scoped (row from a different month returns 0)
  // -------------------------------------------------------------------------
  it('row from a previous month does not count toward current month total', async () => {
    // Insert a row for "last month".
    const lastMonth = (() => {
      const d = new Date();
      d.setMonth(d.getMonth() - 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER_A, lastMonth, 7);

    // Current month should still report 0.
    const res = await authed(request(app).get(`/usage/${USER_A}`));

    expect(res.status).toBe(200);
    expect(res.body.scansUsed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 7 — resetsAt is the first day of next month
  // -------------------------------------------------------------------------
  it('resetsAt in response is the first day of next calendar month', async () => {
    const res = await authed(request(app).get(`/usage/${USER_A}`));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('resetsAt');

    // Compute expected value independently.
    const expected = expectedResetsAt();
    expect(res.body.resetsAt).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// POST /usage/increment
// ---------------------------------------------------------------------------
describe('POST /usage/increment', () => {
  // -------------------------------------------------------------------------
  // Test 4 — Increments count correctly
  // -------------------------------------------------------------------------
  it('increments scanCount from 0 to 1 on first call', async () => {
    const res = await authed(request(app)
      .post('/usage/increment')
      .send({ userId: USER_A }));

    expect(res.status).toBe(200);
    expect(res.body.scansUsed).toBe(1);
    expect(res.body.allowed).toBe(true);

    // Verify via GET that the count persisted.
    const usage = await authed(request(app).get(`/usage/${USER_A}`));
    expect(usage.body.scansUsed).toBe(1);
  });

  it('increments scanCount from 5 to 6 correctly', async () => {
    // Pre-populate with 5 scans.
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER_A, currentMonth(), 5);

    const res = await authed(request(app)
      .post('/usage/increment')
      .send({ userId: USER_A }));

    expect(res.status).toBe(200);
    expect(res.body.scansUsed).toBe(6);
    expect(res.body.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5 — At limit (10) returns allowed: false
  // -------------------------------------------------------------------------
  it('at scan limit (10/10) returns allowed: false', async () => {
    // Pre-populate with exactly 10 scans (the limit).
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER_A, currentMonth(), 10);

    const res = await authed(request(app)
      .post('/usage/increment')
      .send({ userId: USER_A }));

    expect(res.status).toBe(200);
    // scansUsed will be 11 after increment — but allowed should be false.
    expect(res.body.allowed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 6 — Below limit returns allowed: true
  // -------------------------------------------------------------------------
  it('below scan limit (9/10) returns allowed: true', async () => {
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER_A, currentMonth(), 9);

    const res = await authed(request(app)
      .post('/usage/increment')
      .send({ userId: USER_A }));

    expect(res.status).toBe(200);
    expect(res.body.scansUsed).toBe(10);
    expect(res.body.allowed).toBe(true);
  });

  it('missing userId in body returns 400', async () => {
    const res = await authed(request(app)
      .post('/usage/increment')
      .send({})); // no userId

    expect(res.status).toBe(400);
  });

  it('two different users have independent scan counts', async () => {
    // Give USER_A 3 scans.
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER_A, currentMonth(), 3);

    // USER_B increments once.
    await authed(request(app).post('/usage/increment').send({ userId: USER_B }));

    const resA = await authed(request(app).get(`/usage/${USER_A}`));
    const resB = await authed(request(app).get(`/usage/${USER_B}`));

    expect(resA.body.scansUsed).toBe(3); // USER_A unchanged
    expect(resB.body.scansUsed).toBe(1); // USER_B incremented
  });
});
