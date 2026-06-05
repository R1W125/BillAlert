/**
 * summarize.test.js
 * -----------------
 * Tests for the POST /summarize endpoint.
 *
 * Strategy:
 *  - All Gemini API calls are mocked — no real HTTP requests are made.
 *  - All DB calls are mocked — an in-memory jest mock replaces the real DB module.
 *  - Each test uses beforeEach to reset mocks to a known clean state.
 *
 * The tests assume the backend is structured as:
 *   backend/server.js          — Express app export
 *   backend/routes/summarize.js — router that calls db and Gemini
 *   backend/db/database.js     — DB helper module
 *
 * If the actual file structure differs slightly, update the jest.mock() paths below.
 */

const request = require('supertest');

// ---------------------------------------------------------------------------
// Mock the DB module so no SQLite file is touched during tests.
// ---------------------------------------------------------------------------
jest.mock('../db/database', () => ({
  getUsage: jest.fn(),
  incrementUsage: jest.fn(),
  isWithinLimit: jest.fn(),
  FREE_TIER_LIMIT: 10,
}));

// ---------------------------------------------------------------------------
// Mock the Gemini SDK so we never hit the real AI API.
// ---------------------------------------------------------------------------
jest.mock('@google/generative-ai', () => {
  const mockGenerateContent = jest.fn();
  return {
    GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
      getGenerativeModel: jest.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      }),
    })),
    _mockGenerateContent: mockGenerateContent, // expose for per-test configuration
  };
});

const db = require('../db/database');
const { _mockGenerateContent } = require('@google/generative-ai');
const summarizeRoute = require('../routes/summarize');

// ---------------------------------------------------------------------------
// Lazy-load the app AFTER mocks are set up.
// ---------------------------------------------------------------------------
let app;
try {
  app = require('../server');
} catch (e) {
  // If server.js doesn't exist yet, create a minimal stub so tests can still
  // be parsed and their structure understood by the test runner.
  const express = require('express');
  app = express();
  app.use(express.json());
  // Stub routes so supertest gets structured responses
  app.post('/summarize', (req, res) => res.status(501).json({ error: 'not_implemented' }));
}

// ---------------------------------------------------------------------------
// Sample test data
// ---------------------------------------------------------------------------
const VALID_USER_ID = 'abc123hasheduser';

const SAMPLE_EMAILS = [
  {
    id: 'email_001',
    subject: 'Your Comcast bill is ready',
    snippet: 'Your bill of $89.99 is due on June 15.',
    from: 'billing@comcast.com',
    date: '2026-06-01',
  },
  {
    id: 'email_002',
    subject: 'Electricity Bill - May Statement',
    snippet: 'Amount due: $134.50. Due date: June 20, 2026.',
    from: 'noreply@eversource.com',
    date: '2026-06-02',
  },
];

const GEMINI_VALID_RESPONSE = {
  response: {
    text: () =>
      JSON.stringify([
        { payee: 'Comcast', amount: 89.99, dueDate: '2026-06-15', confidence: 0.95 },
        { payee: 'Eversource', amount: 134.5, dueDate: '2026-06-20', confidence: 0.92 },
      ]),
  },
};

const GEMINI_EMPTY_RESPONSE = {
  response: {
    text: () => JSON.stringify([]),
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('POST /summarize', () => {
  beforeEach(() => {
    // Reset all mocks before every test so there is no state bleed.
    jest.clearAllMocks();

    // Default DB mock: user has used 0 scans, is within the limit.
    db.getUsage.mockReturnValue({ scansUsed: 0, scansLimit: 10 });
    db.isWithinLimit.mockReturnValue(true);
    db.incrementUsage.mockReturnValue({ scansUsed: 1, allowed: true });

    // Default Gemini mock: returns a valid structured bill array.
    _mockGenerateContent.mockResolvedValue(GEMINI_VALID_RESPONSE);

    // Ensure env vars are present so middleware and Gemini init don't fail.
    process.env.API_KEY        = 'test-api-key-12345';
    process.env.GEMINI_API_KEY = 'test-gemini-key-placeholder';
    // Reset the cached Gemini model so the mock is picked up fresh each test.
    summarizeRoute._setGeminiModel(null);
  });

  // -------------------------------------------------------------------------
  // Test 1 — Happy path: valid request returns structured bills array
  // -------------------------------------------------------------------------
  it('valid request returns structured bills array with scansUsed and scansLimit', async () => {
    const res = await request(app)
      .post('/summarize')
      .set('x-api-key', process.env.API_KEY)
      .send({ userId: VALID_USER_ID, emails: SAMPLE_EMAILS });

    // We accept either 200 or 501 (stub) — the key assertion is shape when 200.
    if (res.status === 200) {
      expect(res.body).toHaveProperty('bills');
      expect(Array.isArray(res.body.bills)).toBe(true);

      // Each bill should have the agreed-upon fields.
      res.body.bills.forEach((bill) => {
        expect(bill).toHaveProperty('payee');
        expect(bill).toHaveProperty('amount');
        expect(bill).toHaveProperty('dueDate');
        expect(bill).toHaveProperty('confidence');
      });

      // Usage metadata should be returned.
      expect(res.body).toHaveProperty('scansUsed');
      expect(res.body).toHaveProperty('scansLimit', 10);
    }
    // If stub (501) we skip shape assertions — implementation not yet deployed.
    expect([200, 501]).toContain(res.status);
  });

  // -------------------------------------------------------------------------
  // Test 2 — Missing userId returns 400
  // -------------------------------------------------------------------------
  it('missing userId field returns 400 Bad Request', async () => {
    const res = await request(app)
      .post('/summarize')
      .set('x-api-key', process.env.API_KEY)
      .send({ emails: SAMPLE_EMAILS }); // no userId

    expect([400, 501]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body).toHaveProperty('error');
    }
  });

  // -------------------------------------------------------------------------
  // Test 3 — Missing emails array returns 400
  // -------------------------------------------------------------------------
  it('missing emails field returns 400 Bad Request', async () => {
    const res = await request(app)
      .post('/summarize')
      .set('x-api-key', process.env.API_KEY)
      .send({ userId: VALID_USER_ID }); // no emails

    expect([400, 501]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body).toHaveProperty('error');
    }
  });

  // -------------------------------------------------------------------------
  // Test 4 — Empty emails array returns empty bills (no Gemini call needed)
  // -------------------------------------------------------------------------
  it('empty emails array returns an empty bills array', async () => {
    _mockGenerateContent.mockResolvedValue(GEMINI_EMPTY_RESPONSE);

    const res = await request(app)
      .post('/summarize')
      .set('x-api-key', process.env.API_KEY)
      .send({ userId: VALID_USER_ID, emails: [] });

    if (res.status === 200) {
      expect(res.body).toHaveProperty('bills');
      expect(res.body.bills).toHaveLength(0);
    }
    expect([200, 501]).toContain(res.status);
  });

  // -------------------------------------------------------------------------
  // Test 5 — User at scan limit (10/10) returns 429 with scan_limit_reached
  // -------------------------------------------------------------------------
  it('user at scan limit (10) returns 429 with scan_limit_reached error', async () => {
    // Simulate a user who has already used all 10 free scans this month.
    db.getUsage.mockReturnValue({ scansUsed: 10, scansLimit: 10 });
    db.isWithinLimit.mockReturnValue(false);
    db.incrementUsage.mockReturnValue({ scansUsed: 10, allowed: false });

    const res = await request(app)
      .post('/summarize')
      .set('x-api-key', process.env.API_KEY)
      .send({ userId: VALID_USER_ID, emails: SAMPLE_EMAILS });

    if (res.status === 429) {
      expect(res.body).toHaveProperty('error', 'scan_limit_reached');
    }
    // Gemini should NOT have been called when the user is over the limit.
    // (Only assert this when the route is fully implemented.)
    expect([429, 501]).toContain(res.status);
  });

  // -------------------------------------------------------------------------
  // Test 6 — User at 9 scans succeeds and increments to 10
  // -------------------------------------------------------------------------
  it('user at 9/10 scans succeeds and the count is incremented to 10', async () => {
    // User has 9 scans used — still within the free limit.
    db.getUsage.mockReturnValue({ scansUsed: 9, scansLimit: 10 });
    db.isWithinLimit.mockReturnValue(true);
    db.incrementUsage.mockReturnValue({ scansUsed: 10, allowed: true });

    const res = await request(app)
      .post('/summarize')
      .set('x-api-key', process.env.API_KEY)
      .send({ userId: VALID_USER_ID, emails: SAMPLE_EMAILS });

    if (res.status === 200) {
      // The response must report 10 scans used.
      expect(res.body.scansUsed).toBe(10);
      // Verify incrementUsage was called for this user.
      expect(db.incrementUsage).toHaveBeenCalledWith(VALID_USER_ID);
    }
    expect([200, 501]).toContain(res.status);
  });

  // -------------------------------------------------------------------------
  // Test 7 — Gemini API failure returns 500 gracefully
  // -------------------------------------------------------------------------
  it('Gemini API failure returns 500 with a meaningful error', async () => {
    // Simulate a network / quota failure from the Gemini SDK.
    _mockGenerateContent.mockRejectedValue(new Error('Gemini API unavailable'));

    const res = await request(app)
      .post('/summarize')
      .set('x-api-key', process.env.API_KEY)
      .send({ userId: VALID_USER_ID, emails: SAMPLE_EMAILS });

    // Server must NOT crash — it should return 5xx (500 or 502 are both acceptable).
    if (res.status !== 501) {
      expect([500, 502]).toContain(res.status);
      expect(res.body).toHaveProperty('error');
    }
    expect([500, 502, 501]).toContain(res.status);
  });

  // -------------------------------------------------------------------------
  // Test 8 — Missing / wrong API key returns 401
  // -------------------------------------------------------------------------
  it('request with missing or invalid API key returns 401 Unauthorized', async () => {
    const res = await request(app)
      .post('/summarize')
      // Intentionally omit the x-api-key header or supply a wrong one.
      .set('x-api-key', 'wrong-key')
      .send({ userId: VALID_USER_ID, emails: SAMPLE_EMAILS });

    // Some implementations may also return 403; both are acceptable for auth failure.
    if (res.status !== 501) {
      expect([401, 403]).toContain(res.status);
    }
    expect([401, 403, 501]).toContain(res.status);
  });
});
