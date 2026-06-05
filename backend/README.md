# BillAlert Backend

Node.js / Express API that powers the BillAlert Chrome extension.

- Accepts Gmail email snippets, sends them to **Gemini 1.5 Flash**, and returns structured bill data.
- Tracks monthly scan counts per user (free tier: 10 scans/month).
- Uses **SQLite** (via `better-sqlite3`) for zero-infrastructure local storage.

---

## Local Setup

### Prerequisites
- Node.js >= 18
- A [Google AI Studio](https://aistudio.google.com/app/apikey) Gemini API key

### 1. Install dependencies

```bash
cd backend
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Gemini API key from Google AI Studio |
| `API_KEY` | Shared secret between extension and server (generate with `openssl rand -hex 32`) |
| `ADMIN_KEY` | Admin key for the `/usage/reset` endpoint (different from `API_KEY`) |
| `PORT` | Port to listen on (default: `3000`) |
| `ALLOWED_ORIGIN` | Chrome extension origin, e.g. `chrome-extension://<id>`. Leave blank in development to allow all. |

### 3. Start the development server

```bash
npm run dev      # auto-restarts on file changes via nodemon
# or
npm start        # production start
```

The server will be available at `http://localhost:3000`.

### 4. Verify it's running

```bash
curl http://localhost:3000/
# {"status":"ok","service":"BillAlert API"}
```

---

## Running Tests

```bash
npm test
```

Tests use **Jest** + **supertest** and mock the Gemini API so no real API calls are made.

---

## API Reference

All endpoints (except `GET /`) require the header:
```
X-API-Key: <your API_KEY>
```

---

### `GET /`
Health check. No authentication required.

**Response:**
```json
{ "status": "ok", "service": "BillAlert API" }
```

---

### `POST /summarize`
Scans email snippets and extracts bill information via Gemini.

**Request body:**
```json
{
  "userId": "sha256-hashed-google-sub",
  "emails": [
    {
      "id": "18a3f...",
      "subject": "Your bill is ready",
      "snippet": "Your Comcast bill of $89.99 is due on June 15.",
      "from": "billing@comcast.com",
      "date": "2026-06-01"
    }
  ]
}
```

**Success response (200):**
```json
{
  "bills": [
    {
      "payee": "Comcast",
      "amount": "$89.99",
      "dueDate": "2026-06-15",
      "confidence": 0.97
    }
  ],
  "scansUsed": 3,
  "scansLimit": 10
}
```

**Error responses:**
| Status | `error` field | Meaning |
|---|---|---|
| 400 | `invalid_request` | Missing/invalid fields |
| 429 | `scan_limit_reached` | Free tier limit (10/month) exhausted |
| 502 | `ai_error` | Gemini API failure |
| 503 | `service_unavailable` | `GEMINI_API_KEY` not configured |

---

### `GET /usage/:userId`
Returns current-month scan usage for a user.

**Response:**
```json
{
  "scansUsed": 3,
  "scansLimit": 10,
  "tier": "free",
  "resetsAt": "2026-07-01T00:00:00.000Z"
}
```

---

### `POST /usage/increment`
Increments the scan count for a user. Called internally by `/summarize`; exposed for flexibility.

**Request body:**
```json
{ "userId": "sha256-hashed-google-sub" }
```

**Response:**
```json
{ "scansUsed": 4, "allowed": true }
```

---

### `POST /usage/reset` *(admin only)*
Resets a user's monthly scan count to 0. Requires an additional `X-Admin-Key` header.

**Headers:**
```
X-API-Key: <API_KEY>
X-Admin-Key: <ADMIN_KEY>
```

**Request body:**
```json
{ "userId": "sha256-hashed-google-sub" }
```

**Response:**
```json
{ "success": true, "message": "Usage reset for user abc123..." }
```

---

## Deployment

### Railway

1. Push the `backend/` directory to a GitHub repository (or use a monorepo).
2. Create a new **Railway** project and connect your repo.
3. Railway auto-detects Node.js. Set the **root directory** to `backend/` if using a monorepo.
4. Add environment variables in the Railway dashboard:
   - `GEMINI_API_KEY`
   - `API_KEY`
   - `ADMIN_KEY`
   - `ALLOWED_ORIGIN` (your extension's `chrome-extension://<id>`)
5. Railway sets `PORT` automatically — the server reads it from `process.env.PORT`.
6. Deploy. Your URL will be something like `https://bilalert-production.up.railway.app`.

> **SQLite note:** Railway's filesystem is ephemeral on the free plan. For persistent usage data, upgrade to a paid plan with a volume, or migrate to Railway's managed Postgres (requires updating `db/database.js`).

---

### Render

1. Create a new **Web Service** on [render.com](https://render.com).
2. Connect your GitHub repo. Set **Root Directory** to `backend/` if using a monorepo.
3. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** `Node`
4. Add environment variables in the Render dashboard (same as Railway above).
5. For persistent SQLite, attach a **Render Disk** and set the mount path to `/app/backend/db/data`.
   - Update `DB_PATH` in `db/database.js` to `/app/backend/db/data/bilalert.db` if you use this mount path, or rely on the relative `./data/` path (works when the disk is mounted at the app root).
6. Deploy. Your URL will be `https://<service-name>.onrender.com`.

> **Free tier sleep:** Render free web services sleep after 15 minutes of inactivity. The first request after sleep may take ~30 seconds. Upgrade to a paid instance type to avoid this.

---

## Database

- Engine: SQLite via `better-sqlite3`
- File: `backend/db/data/bilalert.db` (created automatically on first run)
- The `data/` directory is git-ignored — never commit the DB file.

### Schema

```sql
CREATE TABLE usage (
  userId     TEXT     NOT NULL,
  month      TEXT     NOT NULL,  -- "YYYY-MM"
  scanCount  INTEGER  DEFAULT 0,
  tier       TEXT     DEFAULT 'free',
  createdAt  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt  DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (userId, month)
);
```

Monthly resets are implicit: each new calendar month creates a fresh row, so the previous month's count is preserved as a historical record without any cron jobs.

---

## Monetisation (stub)

The `tier` column exists in the schema but Stripe integration is not yet implemented.

- `free`: 10 scans/month
- `paid`: unlimited (enforced in `db/database.js` `isWithinLimit()`)

When a user hits the limit, the API returns:
```json
{
  "error": "scan_limit_reached",
  "message": "Upgrade to BillAlert Pro for unlimited scans"
}
```
