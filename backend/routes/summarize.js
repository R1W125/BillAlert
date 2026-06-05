/**
 * routes/summarize.js
 * --------------------
 * POST /summarize
 *
 * Accepts a batch of Gmail email snippets, sends them to Gemini 1.5 Flash,
 * and returns structured bill data (payee, amount, dueDate, confidence).
 *
 * Privacy note:
 *   - Raw email content is NEVER logged or persisted.
 *   - Only userId and scan count are logged.
 *   - Gemini receives anonymised snippets only (no email address metadata beyond
 *     what the caller chooses to send).
 */

'use strict';

const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const { isWithinLimit, incrementUsage, getUsage, FREE_TIER_LIMIT } = require('../db/database');

// ---------------------------------------------------------------------------
// Gemini client (lazy init so tests can override GEMINI_API_KEY)
// ---------------------------------------------------------------------------

let _geminiModel = null;

function getGeminiModel() {
  if (_geminiModel) return _geminiModel;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  _geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  return _geminiModel;
}

// Exposed for testing — lets test suite swap in a mock
function _setGeminiModel(mock) {
  _geminiModel = mock;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * buildPrompt(emails)
 * Constructs the Gemini prompt from the email list.
 * We explicitly ask for JSON-only output so it's easy to parse.
 *
 * @param {Array<{id, subject, snippet, from, date}>} emails
 * @returns {string}
 */
function buildPrompt(emails) {
  const emailSummaries = emails
    .map(
      (e, i) =>
        `Email ${i + 1}:
Subject: ${e.subject || '(no subject)'}
From: ${e.from || '(unknown sender)'}
Date: ${e.date || '(unknown date)'}
Snippet: ${e.snippet || '(empty)'}`
    )
    .join('\n\n');

  return `You are a billing assistant. Analyze the following email snippets and extract any bill, invoice, or payment due information.

${emailSummaries}

Return ONLY a JSON array (no markdown, no explanation) where each element represents one identified bill:
[
  {
    "payee": "string — the company or person to be paid",
    "amount": "string — the monetary amount with currency symbol, e.g. '$42.99'. Use null if not found.",
    "dueDate": "string — the due date in ISO 8601 format (YYYY-MM-DD) if determinable, otherwise a human-readable date. Use null if not found.",
    "confidence": "number — your confidence score from 0.0 to 1.0 that this is a genuine bill/payment email"
  }
]

Rules:
- Include an entry for each email that appears to be a bill, invoice, subscription renewal, or payment reminder.
- Omit emails that are clearly not financial (newsletters, promotions unrelated to payment, etc.).
- If an email contains multiple bills, create multiple entries.
- Do NOT fabricate amounts or dates — use null if the information is absent.
- Output ONLY the JSON array. No text before or after it.`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * parseGeminiResponse(text)
 * Extracts and validates the JSON array from Gemini's response text.
 *
 * @param {string} text
 * @returns {Array}
 * @throws {Error} if the response cannot be parsed as a JSON array
 */
function parseGeminiResponse(text) {
  // Strip potential markdown code fences (```json ... ```)
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Attempt to extract the first JSON array from the text
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      throw new Error(`Gemini returned non-JSON response: ${cleaned.slice(0, 200)}`);
    }
    parsed = JSON.parse(match[0]);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Gemini response is not a JSON array');
  }

  // Normalise each entry to the expected shape
  return parsed.map((item) => ({
    payee: item.payee || null,
    amount: item.amount || null,
    dueDate: item.dueDate || null,
    confidence: typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : null,
  }));
}

// ---------------------------------------------------------------------------
// POST /summarize
// ---------------------------------------------------------------------------

router.post('/', async (req, res) => {
  const { userId, emails } = req.body || {};

  // --- Input validation ---
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return res.status(400).json({ error: 'invalid_request', message: 'userId is required' });
  }

  if (!Array.isArray(emails)) {
    return res.status(400).json({ error: 'invalid_request', message: 'emails must be an array' });
  }

  // Empty array is valid — nothing to scan, return early with empty result.
  if (emails.length === 0) {
    return res.json({ bills: [], scansUsed: 0, scansLimit: FREE_TIER_LIMIT });
  }

  if (emails.length > 50) {
    return res.status(400).json({ error: 'invalid_request', message: 'Maximum 50 emails per request' });
  }

  const uid = userId.trim();

  // --- Free tier limit check ---
  const withinLimit = isWithinLimit(uid);
  if (!withinLimit) {
    const usage = getUsage(uid);
    console.log(`[summarize] userId=${uid} scan_limit_reached scansUsed=${usage.scanCount}`);
    return res.status(429).json({
      error: 'scan_limit_reached',
      message: 'Upgrade to BillAlert Pro for unlimited scans',
      scansUsed: usage.scanCount,
      scansLimit: FREE_TIER_LIMIT,
    });
  }

  // --- Call Gemini ---
  let bills;
  try {
    const model = getGeminiModel();
    const prompt = buildPrompt(emails);

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    bills = parseGeminiResponse(responseText);
  } catch (err) {
    console.error(`[summarize] Gemini error for userId=${uid}:`, err.message);

    if (err.message.includes('GEMINI_API_KEY')) {
      return res.status(503).json({ error: 'service_unavailable', message: 'AI service not configured' });
    }

    return res.status(502).json({
      error: 'ai_error',
      message: 'Failed to process emails with AI service. Please try again.',
    });
  }

  // --- Increment usage AFTER successful AI call ---
  const usageResult = incrementUsage(uid);

  // Log only non-sensitive info
  console.log(`[summarize] userId=${uid} scansUsed=${usageResult.scansUsed} billsFound=${bills.length}`);

  return res.json({
    bills,
    scansUsed: usageResult.scansUsed,
    scansLimit: FREE_TIER_LIMIT,
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = router;
module.exports._setGeminiModel = _setGeminiModel;
module.exports._buildPrompt = buildPrompt;
module.exports._parseGeminiResponse = parseGeminiResponse;
