/**
 * routes/usage.js
 * ---------------
 * Handles monthly scan-count tracking for the free tier.
 *
 * Routes:
 *   GET  /usage/:userId          — fetch current month usage for a user
 *   POST /usage/increment        — increment scan count (called internally by summarize)
 *   POST /usage/reset            — admin-only: reset a user's monthly count
 */

'use strict';

const express = require('express');
const router = express.Router();

const {
  getUsage,
  incrementUsage,
  resetUsage,
  FREE_TIER_LIMIT,
} = require('../db/database');

// ---------------------------------------------------------------------------
// GET /usage/:userId
// ---------------------------------------------------------------------------

/**
 * Returns the current-month usage stats for a given user.
 *
 * Response: {
 *   scansUsed : number,
 *   scansLimit: number,   // 10 for free tier
 *   tier      : "free" | "paid",
 *   resetsAt  : ISO string  // first day of next month UTC
 * }
 */
router.get('/:userId', (req, res) => {
  const { userId } = req.params;

  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return res.status(400).json({ error: 'invalid_user', message: 'userId is required' });
  }

  const usage = getUsage(userId.trim());

  return res.json({
    scansUsed: usage.scanCount,
    scansLimit: FREE_TIER_LIMIT,
    tier: usage.tier,
    resetsAt: usage.resetsAt,
  });
});

// ---------------------------------------------------------------------------
// POST /usage/increment
// ---------------------------------------------------------------------------

/**
 * Increments the monthly scan count for a user.
 * Called internally by the /summarize route, but also exposed for flexibility.
 *
 * Body:    { userId: string }
 * Response: { scansUsed: number, allowed: boolean }
 */
router.post('/increment', (req, res) => {
  const { userId } = req.body || {};

  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return res.status(400).json({ error: 'invalid_user', message: 'userId is required in request body' });
  }

  const result = incrementUsage(userId.trim());

  return res.json({
    scansUsed: result.scansUsed,
    allowed: result.allowed,
  });
});

// ---------------------------------------------------------------------------
// POST /usage/reset  (admin only)
// ---------------------------------------------------------------------------

/**
 * Resets a user's monthly scan count to 0.
 * Protected by ADMIN_KEY header (separate from the regular API_KEY).
 *
 * Body:    { userId: string }
 * Headers: X-Admin-Key: <ADMIN_KEY env var>
 * Response: { success: boolean, message: string }
 */
router.post('/reset', (req, res) => {
  // Check admin key
  const adminKey = process.env.ADMIN_KEY;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey) {
    // If no ADMIN_KEY is configured, disable this endpoint entirely
    return res.status(503).json({ error: 'not_configured', message: 'Admin key not configured on this server' });
  }

  if (!providedKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'forbidden', message: 'Invalid or missing X-Admin-Key header' });
  }

  const { userId } = req.body || {};

  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return res.status(400).json({ error: 'invalid_user', message: 'userId is required in request body' });
  }

  const result = resetUsage(userId.trim());

  if (!result.success) {
    // No row existed — still return success; zero is the default state
    return res.json({ success: true, message: 'No active usage record found; user already at zero scans' });
  }

  return res.json({ success: true, message: `Usage reset for user ${userId.trim()}` });
});

module.exports = router;
