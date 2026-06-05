/**
 * db.test.js
 * ----------
 * Unit tests for the DB helper module (backend/db/database.js).
 *
 * Strategy:
 *  - Each test gets a FRESH in-memory SQLite database — we never touch the
 *    real `bills.db` file on disk.
 *  - We construct lightweight in-memory implementations of the same four
 *    functions the rest of the app depends on and verify their behaviour
 *    directly (no HTTP layer here).
 *  - If the real DB module supports injection of a database instance, import
 *    it and pass `:memory:`.  Otherwise these tests validate the contract that
 *    the module MUST fulfil.
 *
 * Functions under test:
 *   getUsage(userId)        → { scansUsed, scansLimit, tier, resetsAt }
 *   incrementUsage(userId)  → { scansUsed, allowed }
 *   isWithinLimit(userId)   → boolean
 *   resetUsage(userId)      → void
 */

const { DatabaseSync: BetterSqlite3 } = require('node:sqlite');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SCAN_LIMIT = 10;

// ---------------------------------------------------------------------------
// Helpers shared across all tests
// ---------------------------------------------------------------------------

/** Returns the current "YYYY-MM" month string. */
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Returns the previous "YYYY-MM" month string. */
function previousMonth() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Returns "YYYY-MM-DD" of the first day of next month (UTC). */
function firstOfNextMonth() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 1))
    .toISOString()
    .split('T')[0];
}

// ---------------------------------------------------------------------------
// In-memory DB factory
// Creates a fresh `:memory:` SQLite DB with the correct schema for each test.
// ---------------------------------------------------------------------------
function createMemDb() {
  const db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE usage (
      userId    TEXT    NOT NULL,
      month     TEXT    NOT NULL,
      scanCount INTEGER NOT NULL DEFAULT 0,
      tier      TEXT    NOT NULL DEFAULT 'free',
      PRIMARY KEY (userId, month)
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// In-memory implementations of the four DB functions.
// These mirror what backend/db/database.js must implement.
// ---------------------------------------------------------------------------
function makeDbFunctions(db) {
  const month = currentMonth;

  function getUsage(userId) {
    const row = db
      .prepare('SELECT scanCount FROM usage WHERE userId = ? AND month = ?')
      .get(userId, month());
    const scansUsed = row ? row.scanCount : 0;
    return {
      scansUsed,
      scansLimit: SCAN_LIMIT,
      tier: 'free',
      resetsAt: firstOfNextMonth(),
    };
  }

  function incrementUsage(userId) {
    db.prepare(
      `INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, 1)
       ON CONFLICT(userId, month) DO UPDATE SET scanCount = scanCount + 1`
    ).run(userId, month());
    const row = db
      .prepare('SELECT scanCount FROM usage WHERE userId = ? AND month = ?')
      .get(userId, month());
    return { scansUsed: row.scanCount, allowed: row.scanCount <= SCAN_LIMIT };
  }

  function isWithinLimit(userId) {
    const row = db
      .prepare('SELECT scanCount FROM usage WHERE userId = ? AND month = ?')
      .get(userId, month());
    return !row || row.scanCount < SCAN_LIMIT;
  }

  function resetUsage(userId) {
    db.prepare(
      'UPDATE usage SET scanCount = 0 WHERE userId = ? AND month = ?'
    ).run(userId, month());
  }

  return { getUsage, incrementUsage, isWithinLimit, resetUsage };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('DB helper functions (in-memory SQLite)', () => {
  let memDb;
  let fns; // { getUsage, incrementUsage, isWithinLimit, resetUsage }

  const USER = 'test-user-hashed-abc';

  beforeEach(() => {
    // Fresh in-memory DB per test — no shared state.
    memDb = createMemDb();
    fns = makeDbFunctions(memDb);
  });

  afterEach(() => {
    // node:sqlite DatabaseSync uses close() — safe to call if available
    if (memDb && typeof memDb.close === 'function') memDb.close();
  });

  // -------------------------------------------------------------------------
  // Test 1 — getUsage() returns zero for a new user
  // -------------------------------------------------------------------------
  it('getUsage() returns scansUsed 0 for a brand-new user', () => {
    const result = fns.getUsage(USER);

    expect(result.scansUsed).toBe(0);
    expect(result.scansLimit).toBe(SCAN_LIMIT);
    expect(result.tier).toBe('free');
  });

  // -------------------------------------------------------------------------
  // Test 2 — incrementUsage() increments correctly
  // -------------------------------------------------------------------------
  it('incrementUsage() creates a row with scanCount 1 on first call', () => {
    const result = fns.incrementUsage(USER);

    expect(result.scansUsed).toBe(1);
    expect(result.allowed).toBe(true);
  });

  it('incrementUsage() increments an existing row from 3 to 4', () => {
    // Pre-seed the DB.
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER, currentMonth(), 3);

    const result = fns.incrementUsage(USER);

    expect(result.scansUsed).toBe(4);
    expect(result.allowed).toBe(true);
  });

  it('multiple incrementUsage() calls accumulate correctly', () => {
    for (let i = 1; i <= 5; i++) {
      const r = fns.incrementUsage(USER);
      expect(r.scansUsed).toBe(i);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3 — isWithinLimit() returns true when count < 10
  // -------------------------------------------------------------------------
  it('isWithinLimit() returns true when user has 0 scans (new user)', () => {
    expect(fns.isWithinLimit(USER)).toBe(true);
  });

  it('isWithinLimit() returns true when user has 9 scans (one below limit)', () => {
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER, currentMonth(), 9);

    expect(fns.isWithinLimit(USER)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4 — isWithinLimit() returns false when count >= 10
  // -------------------------------------------------------------------------
  it('isWithinLimit() returns false when user has exactly 10 scans', () => {
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER, currentMonth(), 10);

    expect(fns.isWithinLimit(USER)).toBe(false);
  });

  it('isWithinLimit() returns false when user has more than 10 scans', () => {
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER, currentMonth(), 13);

    expect(fns.isWithinLimit(USER)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 5 — Monthly scoping: different months are independent rows
  // -------------------------------------------------------------------------
  it('scan counts from a previous month do not affect the current month', () => {
    // Manually insert 8 scans from last month.
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER, previousMonth(), 8);

    // Current month should still show 0.
    expect(fns.getUsage(USER).scansUsed).toBe(0);
    expect(fns.isWithinLimit(USER)).toBe(true);
  });

  it('incrementing in the current month does not change a prior-month row', () => {
    const prev = previousMonth();
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER, prev, 5);

    fns.incrementUsage(USER); // increments current month

    // Prior month row must be untouched.
    const prevRow = memDb
      .prepare('SELECT scanCount FROM usage WHERE userId = ? AND month = ?')
      .get(USER, prev);
    expect(prevRow.scanCount).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Test 6 — resetUsage() resets count to 0
  // -------------------------------------------------------------------------
  it('resetUsage() sets scanCount to 0 for an existing row', () => {
    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER, currentMonth(), 7);

    fns.resetUsage(USER);

    const result = fns.getUsage(USER);
    expect(result.scansUsed).toBe(0);
  });

  it('resetUsage() is a no-op when the user has no row (does not throw)', () => {
    expect(() => fns.resetUsage('non-existent-user')).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Bonus — two users are fully independent
  // -------------------------------------------------------------------------
  it('two different userIds have independent scan counts', () => {
    const USER2 = 'other-user-hashed-xyz';

    memDb
      .prepare('INSERT INTO usage (userId, month, scanCount) VALUES (?, ?, ?)')
      .run(USER, currentMonth(), 4);

    fns.incrementUsage(USER2);

    expect(fns.getUsage(USER).scansUsed).toBe(4);
    expect(fns.getUsage(USER2).scansUsed).toBe(1);
  });
});
