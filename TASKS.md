---
editor_options: 
  markdown: 
    wrap: 72
---

# BillAlert — Agent Coordination Board

> Last updated: 2026-06-05 This file is the shared coordination layer
> between all agents. Each agent MUST update their status block as they
> progress.

------------------------------------------------------------------------

## Project Overview

Chrome extension that scans Gmail for bill/payment emails, summarizes
them via Gemini 1.5 Flash, and fires scheduled browser notifications.

------------------------------------------------------------------------

## Agent Status

### 🎨 Agent 1 — Frontend (Chrome Extension)

**Status:** `COMPLETE` **Owner files:** - `extension/manifest.json` -
`extension/popup.html` - `extension/popup.js` -
`extension/background.js` - `extension/styles/` - `extension/icons/`

**Tasks:** - [x] manifest.json — MV3, OAuth, permissions - [x]
popup.html — sign-in UI, time picker, bill summary - [x] popup.js —
wires UI to storage + background - [x] background.js — alarms, Gmail
scan trigger, notifications - [x] Basic CSS styling

**Blocked on:** ~~Auth agent completing OAuth token flow contract~~
(stubs in place; will activate when auth.js delivered) **Notes:** All
files written. background.js and popup.js contain guarded calls to
auth.js functions (getStoredToken, getUserEmail, getUserId, signIn,
signOut, clearStoredToken) — gracefully falls back to direct storage
reads until auth.js is ready.

------------------------------------------------------------------------

### ⚙️ Agent 2 — Backend (Node.js Server)

**Status:** `COMPLETE` **Owner files:** - `backend/server.js` -
`backend/routes/summarize.js` - `backend/routes/usage.js` -
`backend/db/database.js` - `backend/package.json` - `backend/README.md`

**Tasks:** - [x] Express server setup - [x] POST /summarize — Gemini 1.5
Flash integration - [x] GET /usage + POST /usage/increment — scan count
tracking - [x] SQLite DB schema (users, scan counts) - [x] API key auth
middleware - [x] README with Railway/Render deploy instructions

**Blocked on:** Nothing — can proceed independently **Notes:** Stripe
stubbed only, no real payments

------------------------------------------------------------------------

### 🔐 Agent 3 — Auth (Gmail OAuth)

**Status:** `COMPLETE` **Owner files:** - `extension/auth.js` - Updates
to `extension/popup.js` (sign-in flow) - Updates to
`extension/background.js` (token attach)

**Tasks:** - [x] chrome.identity OAuth2 flow - [x] Secure token storage
in chrome.storage.local - [x] Token refresh logic - [x] Pass user
identity (hashed) to backend - [x] Ensure read-only Gmail scope enforced

**Blocked on:** ~~Frontend agent manifest.json for OAuth client_id
placeholder~~ **Notes:** Never store raw email content on backend.
auth.js is fully self-contained and exported as globalThis.BillAlertAuth
for use in both popup.js and background.js (service worker).

------------------------------------------------------------------------

### 🧪 Agent 4 — Testing

**Status:** `COMPLETE` **Owner files:** -
`backend/tests/summarize.test.js` - `backend/tests/usage.test.js` -
`backend/tests/db.test.js` - `extension/tests/auth.test.js` -
`extension/tests/alarms.test.js` - `docs/TESTING.md` - `package.json`
(root) - `extension/package.json`

**Tasks:** - [x] Unit tests for /summarize endpoint - [x] Unit tests for
/usage endpoint + limit enforcement - [x] Mock Gmail API responses - [x]
Chrome Alarms notification timing tests - [x] Document test run
instructions

**Blocked on:** Nothing — complete **Notes:** Tests use jest-chrome for
Chrome extension APIs; in-memory SQLite for DB tests; Gemini API fully
mocked

------------------------------------------------------------------------

## Shared Contracts

### Backend API (agreed interface)

```         
POST /summarize
  Body: { userId: string, emails: [{ id, subject, snippet, from, date }] }
  Returns: { bills: [{ payee, amount, dueDate, confidence }] }

GET /usage/:userId
  Returns: { scansUsed: number, scansLimit: number, tier: "free"|"paid" }

POST /usage/increment
  Body: { userId: string }
  Returns: { scansUsed: number, allowed: boolean }
```

### Auth Contract

-   OAuth token stored at: `chrome.storage.local` key `"authToken"`
-   User ID passed to backend: SHA-256 hash of Google `sub` claim
-   Scope: `https://www.googleapis.com/auth/gmail.readonly` ONLY

------------------------------------------------------------------------

## Completion Checklist

-   [x] Agent 1 complete
-   [x] Agent 2 complete
-   [x] Agent 3 complete
-   [x] Agent 4 complete
-   [x] Main agent synthesis & integration verified
-   [x] Extension loads in Chrome without errors (manifest + icons
    ready)
-   [x] Backend 31/31 tests passing
-   [x] Auth module integrated into popup.js and background.js
-   [x] node:sqlite replaces better-sqlite3 (Node v25 compatible)
-   [ ] Full end-to-end flow (requires real Google OAuth Client ID +
    Gemini API key)
