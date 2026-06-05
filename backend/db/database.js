/**
 * database.js
 * -----------
 * SQLite database layer using Node.js built-in `node:sqlite` module
 * (available natively in Node.js v22.5+, stable in v24+).
 *
 * No native compilation required — works out of the box on Node v25.
 *
 * The DB file lives at ./data/bilalert.db (relative to this file).
 * The data/ directory is created automatically if it does not exist.
 *
 * Schema (single table):
 *   usage(userId TEXT, month TEXT, scanCount INTEGER, tier TEXT, createdAt, updatedAt)
 *   PRIMARY KEY (userId, month)
 *
 * Monthly reset is implicit: a new row is created for each (userId, month) pair,
 * so a new calendar month naturally starts with scanCount = 0.
 */

'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'bilalert.db');

// Ensure the data directory exists before opening the DB
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.exec('PRAGMA journal_mode = WAL');

// Create the usage table if it does not already exist
db.exec(`
  CREATE TABLE IF NOT EXISTS usage (
    userId     TEXT     NOT NULL,
    month      TEXT     NOT NULL,
    scanCount  INTEGER  DEFAULT 0,
    tier       TEXT     DEFAULT 'free',
    createdAt  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (userId, month)
  );
`);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FREE_TIER_LIMIT = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the current month string in "YYYY-MM" format.
 */
function currentMonth() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Returns an ISO-8601 date string for the first day of next month at midnight UTC.
 */
function nextMonthResetDate() {
  const now   = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return reset.toISOString();
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * getUsage(userId)
 * Returns the usage record for the current month.
 * If no record exists yet, returns a virtual "zero" object (no DB write).
 */
function getUsage(userId) {
  const month = currentMonth();
  const stmt  = db.prepare(
    'SELECT userId, month, scanCount, tier FROM usage WHERE userId = ? AND month = ?'
  );
  const row = stmt.get(userId, month);

  if (row) {
    return { ...row, resetsAt: nextMonthResetDate() };
  }

  return {
    userId,
    month,
    scanCount: 0,
    tier: 'free',
    resetsAt: nextMonthResetDate(),
  };
}

/**
 * incrementUsage(userId)
 * Atomically increments the scan count for the current month.
 * Inserts a row if none exists yet.
 */
function incrementUsage(userId) {
  const month = currentMonth();

  db.prepare(`
    INSERT INTO usage (userId, month, scanCount, tier, updatedAt)
    VALUES (?, ?, 1, 'free', CURRENT_TIMESTAMP)
    ON CONFLICT (userId, month) DO UPDATE SET
      scanCount = scanCount + 1,
      updatedAt = CURRENT_TIMESTAMP
  `).run(userId, month);

  const row       = db.prepare('SELECT scanCount, tier FROM usage WHERE userId = ? AND month = ?').get(userId, month);
  const scansUsed = row ? row.scanCount : 1;
  const tier      = row ? row.tier : 'free';
  const limit     = tier === 'paid' ? Infinity : FREE_TIER_LIMIT;

  return {
    scansUsed,
    tier,
    allowed: scansUsed <= limit,
  };
}

/**
 * isWithinLimit(userId)
 * Returns true if the user has NOT yet reached their monthly scan limit.
 */
function isWithinLimit(userId) {
  const { scanCount, tier } = getUsage(userId);
  if (tier === 'paid') return true;
  return scanCount < FREE_TIER_LIMIT;
}

/**
 * resetUsage(userId)
 * Resets the scan count to 0 for the current month.
 */
function resetUsage(userId) {
  const month  = currentMonth();
  const result = db.prepare(
    'UPDATE usage SET scanCount = 0, updatedAt = CURRENT_TIMESTAMP WHERE userId = ? AND month = ?'
  ).run(userId, month);
  return { success: result.changes > 0 };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  db,
  getUsage,
  incrementUsage,
  isWithinLimit,
  resetUsage,
  FREE_TIER_LIMIT,
  currentMonth,
  nextMonthResetDate,
};
