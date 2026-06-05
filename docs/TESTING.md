---
editor_options: 
  markdown: 
    wrap: 72
---

# BillAlert — Testing Guide

## Prerequisites

-   **Node.js** \>= 18.0.0 ([download](https://nodejs.org/))
-   **npm** \>= 9 (bundled with Node 18+)

------------------------------------------------------------------------

## Installing Test Dependencies

### Backend

``` bash
cd backend
npm install
```

This installs Jest, Supertest, better-sqlite3, and all production
dependencies.

### Extension

``` bash
cd extension
npm install
```

This installs Jest, jest-chrome, and jest-environment-jsdom.

------------------------------------------------------------------------

## Running Tests

### Backend tests only

``` bash
cd backend
npm test
```

Or from the project root:

``` bash
npm --prefix backend test
```

### Extension tests only

``` bash
cd extension
npm test
```

Or from the project root:

``` bash
npm --prefix extension test
```

### All tests (backend + extension)

From the **project root**:

``` bash
npm test
```

This runs `npm --prefix backend test && npm --prefix extension test`
sequentially.

------------------------------------------------------------------------

## jest-chrome Setup

`jest-chrome` provides a complete mock of the `chrome.*` extension APIs
so tests can run in Node/jsdom without a real browser.

It is automatically configured via the
`"setupFiles": ["jest-chrome/setup"]` entry in `extension/package.json`.
No extra setup is required.

If you need to add a new `chrome.*` API that is not mocked by default,
add it to `extension/tests/__mocks__/chrome.js` or configure it with
`jest.fn()` in the individual test's `beforeEach`.

------------------------------------------------------------------------

## What Each Test Suite Covers

### `backend/tests/summarize.test.js`

Tests the `POST /summarize` endpoint end-to-end (with mocked Gemini and
DB).

| \# | What it tests |
|----|----|
| 1 | Valid request returns a structured `bills` array with `scansUsed`/`scansLimit` |
| 2 | Missing `userId` returns HTTP 400 |
| 3 | Missing `emails` array returns HTTP 400 |
| 4 | Empty `emails` array returns empty `bills` |
| 5 | User at the 10-scan monthly limit receives HTTP 429 `scan_limit_reached` |
| 6 | User at 9 scans succeeds and the count is incremented to 10 |
| 7 | Gemini SDK failure is caught and returns HTTP 500 |
| 8 | Missing or wrong `x-api-key` header returns HTTP 401/403 |

### `backend/tests/usage.test.js`

Tests the `GET /usage/:userId` and `POST /usage/increment` endpoints
using an in-memory SQLite database — the real `bills.db` file is never
touched.

| \#  | What it tests                                                      |
|-----|--------------------------------------------------------------------|
| 1   | New user returns `scansUsed: 0`                                    |
| 2   | Existing user returns the correct count                            |
| 3   | Counts are month-scoped (previous month row = 0 for current month) |
| 4   | `POST /usage/increment` increments the count correctly             |
| 5   | At limit (10/10) `increment` returns `allowed: false`              |
| 6   | Below limit (9/10) `increment` returns `allowed: true`             |
| 7   | `resetsAt` in the response is the first day of next month          |
| \+  | Two users are fully independent; missing `userId` returns 400      |

### `backend/tests/db.test.js`

Unit tests for the DB helper module (`backend/db/database.js`). Every
test gets a fresh in-memory SQLite instance.

| \#  | What it tests                                                        |
|-----|----------------------------------------------------------------------|
| 1   | `getUsage()` returns `scansUsed: 0` for a new user                   |
| 2   | `incrementUsage()` increments correctly (first call, repeated calls) |
| 3   | `isWithinLimit()` returns `true` when count \< 10                    |
| 4   | `isWithinLimit()` returns `false` when count \>= 10                  |
| 5   | Monthly scoping: previous month rows do not affect current month     |
| 6   | `resetUsage()` sets `scanCount` back to 0                            |
| \+  | Two different `userId` values are fully independent                  |

### `extension/tests/auth.test.js`

Tests the Chrome OAuth2 auth module (`extension/auth.js`) with full
`chrome.*` API mocking via jest-chrome.

| \# | What it tests |
|----|----|
| 1 | `signIn()` stores `authToken`, `userEmail`, `userId` in storage on success |
| 2 | `userId` stored is the SHA-256 hash of the Google `sub` claim |
| 3 | `chrome.identity` failure causes `signIn()` to return `{ success: false }` |
| 4 | `signOut()` removes all relevant keys from storage |
| 5 | `signOut()` calls `chrome.identity.removeCachedAuthToken` |
| 6 | `getToken()` returns the token string when it is present |
| 7 | `getToken()` returns `null` and clears storage when token is absent |
| 8 | `isSignedIn()` returns `true` when `signedIn` flag is set |
| 9 | `isSignedIn()` returns `false` when flag is absent |
| 10 | SHA-256 of a known value matches the expected hex digest |

### `extension/tests/alarms.test.js`

Tests Chrome Alarms scheduling and the `scanGmail` trigger in
`extension/background.js`.

| \#  | What it tests                                                        |
|-----|----------------------------------------------------------------------|
| 1   | `onInstalled` (install) creates the `billAlertDaily` alarm           |
| 2   | Daily alarm has `periodInMinutes: 1440` (24 hours)                   |
| 3   | `onAlarm` firing `billAlertDaily` calls `scanGmail()`                |
| 4   | `updateAlarms()` clears old alarms before creating new ones          |
| 5   | Multiple notification times produce multiple alarms                  |
| 6   | `scanNow` message from popup triggers an immediate scan              |
| \+  | Extension update (`reason: update`) re-registers alarms from storage |

------------------------------------------------------------------------

## Adding New Tests

1.  **Backend route test** — add a file under `backend/tests/` named
    `*.test.js`. Use the existing `summarize.test.js` as a template.
    Mock external services at the top of the file with `jest.mock()`.

2.  **DB test** — add to `backend/tests/db.test.js` or create a sibling
    file. Always use `:memory:` for the SQLite connection.

3.  **Extension test** — add a file under `extension/tests/` named
    `*.test.js`. Configure `chrome.*` mocks in `beforeEach`. jest-chrome
    stubs are already available; call `addListener.mock.calls` to
    retrieve registered event callbacks.

4.  **Run your new test in isolation:**

    ``` bash
    # Backend
    cd backend && npx jest tests/my-new.test.js

    # Extension
    cd extension && npx jest tests/my-new.test.js
    ```

5.  **Run the full suite before committing** to verify no regressions:

    ``` bash
    npm test   # from project root
    ```

------------------------------------------------------------------------

## Troubleshooting

| Problem | Fix |
|----|----|
| `Cannot find module '../server'` | The backend server has not been implemented yet. Tests will still parse and structurally pass with the built-in stubs. |
| `Cannot find module '../../extension/auth'` | The auth module has not been implemented yet. Tests document the contract and will begin passing once `auth.js` exists. |
| `chrome is not defined` | Ensure `"setupFiles": ["jest-chrome/setup"]` is in `extension/package.json` and `jest-environment-jsdom` is installed. |
| `better-sqlite3` build error | Run `npm rebuild better-sqlite3` or ensure your Node version matches the prebuilt binary. |
