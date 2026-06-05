/**
 * server.js
 * ---------
 * BillAlert Express API server.
 *
 * Endpoints:
 *   GET  /                    — health check
 *   POST /summarize           — Gemini-powered bill extraction
 *   GET  /usage/:userId       — monthly scan usage
 *   POST /usage/increment     — increment scan count
 *   POST /usage/reset         — admin: reset scan count
 *
 * Security:
 *   All routes (except /) require X-API-Key header matching API_KEY env var.
 *   CORS is restricted to the Chrome extension origin when ALLOWED_ORIGIN is set.
 */

'use strict';

// Load environment variables from .env file (no-op in production if already set)
require('dotenv').config();

const express = require('express');

const summarizeRouter = require('./routes/summarize');
const usageRouter = require('./routes/usage');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const allowedOrigin = process.env.ALLOWED_ORIGIN;

/**
 * Manual CORS middleware — runs before everything else.
 * Explicitly sets headers for Chrome extension and configured origins.
 * Using manual headers instead of the cors() package to ensure preflight
 * responses always include Access-Control-Allow-Origin.
 */
app.use((req, res, next) => {
  const origin = req.headers.origin || '';

  const isAllowed =
    !origin ||
    origin.startsWith('chrome-extension://') ||
    !allowedOrigin ||
    origin === allowedOrigin;

  if (isAllowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Admin-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Respond immediately to preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// Request logger (non-sensitive)
// ---------------------------------------------------------------------------

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// Health check (no auth required)
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'BillAlert API' });
});

// ---------------------------------------------------------------------------
// API key authentication middleware
// ---------------------------------------------------------------------------

/**
 * requireApiKey
 * Validates the X-API-Key header against the API_KEY environment variable.
 * Returns 401 if the key is missing or incorrect.
 */
function requireApiKey(req, res, next) {
  // Always allow OPTIONS preflight requests through so CORS headers are set
  // before any auth check — otherwise the browser never sees the CORS headers.
  if (req.method === 'OPTIONS') return next();

  const serverKey = process.env.API_KEY;

  if (!serverKey) {
    console.error('[auth] API_KEY environment variable is not set — rejecting all requests');
    return res.status(503).json({ error: 'server_misconfigured', message: 'API key not configured on server' });
  }

  const clientKey = req.headers['x-api-key'];

  if (!clientKey) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing X-API-Key header' });
  }

  if (clientKey !== serverKey) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid API key' });
  }

  next();
}

// ---------------------------------------------------------------------------
// Protected routes
// ---------------------------------------------------------------------------

app.use('/summarize', requireApiKey, summarizeRouter);
app.use('/usage', requireApiKey, usageRouter);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'The requested endpoint does not exist' });
});

// ---------------------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err);

  const status = err.status || err.statusCode || 500;
  const message =
    process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err.message || 'An unexpected error occurred';

  res.status(status).json({ error: 'server_error', message });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

// Only start listening when this file is run directly (not when imported in tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[BillAlert] Server listening on port ${PORT}`);
    console.log(`[BillAlert] Health check: http://localhost:${PORT}/`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[BillAlert] SIGTERM received — shutting down gracefully');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[BillAlert] SIGINT received — shutting down');
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Exports (for testing with supertest)
// ---------------------------------------------------------------------------

module.exports = app;
