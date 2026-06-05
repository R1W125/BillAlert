/**
 * background.js — BillAlert Chrome Extension Service Worker
 *
 * Runs in the background (even when the popup is closed). Responsibilities:
 *  1. Set up a default daily alarm at 9:00 AM on first install.
 *  2. On each alarm, scan Gmail for bill-related emails.
 *  3. Send extracted emails to the backend /summarize endpoint.
 *  4. Save the resulting bill list to chrome.storage.local.
 *  5. Fire a browser notification summarising upcoming bills.
 *  6. Listen for messages from the popup (scanNow, updateAlarms).
 *  7. Handle expired auth tokens gracefully.
 *
 * Auth functions (getStoredToken, clearStoredToken) are provided by auth.js.
 * NOTE: In a service worker, auth.js is imported via importScripts().
 */

// Auth functions provided by auth.js — load it into the service worker context.
importScripts('auth.js');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Base URL of the BillAlert backend server. */
const BACKEND_URL = 'https://billalert-production.up.railway.app';

/**
 * Shared API key sent with every backend request via X-API-Key header.
 * Must match the API_KEY environment variable set in Railway.
 */
const EXTENSION_API_KEY = 'YOUR_API_KEY_HERE';

/** Gmail API base URL */
const GMAIL_API_BASE = 'https://www.googleapis.com/gmail/v1/users/me';

/**
 * Gmail search query — finds emails likely to contain bill or payment info
 * sent within the last 30 days.
 */
const GMAIL_QUERY =
  'subject:(bill OR invoice OR payment OR subscription OR due) newer_than:30d';

/** Number of emails to fetch per scan (Gmail API maxResults). */
const MAX_EMAILS = 50;

/** Prefix used for all chrome.alarms names managed by BillAlert. */
const ALARM_PREFIX = 'billalertalarm_';

// ─── Install listener ─────────────────────────────────────────────────────────

/**
 * Fires once when the extension is first installed (or updated).
 * Sets up the default 9:00 AM daily reminder alarm.
 */
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    // No automatic scan on install — user triggers scans manually via
    // the popup. Alarms are only created when the user adds a reminder
    // time in the notification time picker.
    console.log('BillAlert: installed. Scans are manual until user sets a reminder time.');
  }
});

/**
 * Creates a daily alarm for 9:00 AM using the user's local time.
 * Called on first install and whenever the user resets to defaults.
 */
async function setDefaultAlarms() {
  const defaultTimes = ['09:00'];
  await chrome.storage.local.set({ notificationTimes: defaultTimes });
  await recreateAlarms(defaultTimes);
}

// ─── Alarm management ─────────────────────────────────────────────────────────

/**
 * Removes all existing BillAlert alarms and creates new ones for the
 * given array of "HH:MM" time strings.
 *
 * Chrome alarms use a periodInMinutes of 1440 (= 24 hours) to repeat daily.
 * The first fire time is calculated as the next upcoming occurrence of each
 * requested time in the user's local time zone.
 *
 * @param {string[]} times - Array of "HH:MM" strings, e.g. ["09:00", "18:30"]
 */
async function recreateAlarms(times) {
  // Clear all existing BillAlert alarms first.
  const existing = await chrome.alarms.getAll();
  for (const alarm of existing) {
    if (alarm.name.startsWith(ALARM_PREFIX)) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  // Create a new alarm for each requested time.
  for (const time of times) {
    const [hourStr, minStr] = time.split(':');
    const hour = parseInt(hourStr, 10);
    const min  = parseInt(minStr,  10);

    // Calculate the next occurrence of this time.
    const now       = new Date();
    const nextFire  = new Date();
    nextFire.setHours(hour, min, 0, 0);

    // If this time has already passed today, schedule for tomorrow.
    if (nextFire <= now) {
      nextFire.setDate(nextFire.getDate() + 1);
    }

    const alarmName = `${ALARM_PREFIX}${time.replace(':', '_')}`;

    chrome.alarms.create(alarmName, {
      when:            nextFire.getTime(),
      periodInMinutes: 24 * 60, // repeat every 24 hours
    });

    console.log(`BillAlert: alarm set — ${time} (next: ${nextFire.toLocaleString()})`);
  }
}

// ─── Alarm listener ───────────────────────────────────────────────────────────

/**
 * Fires whenever one of our scheduled alarms triggers.
 * Kicks off a Gmail scan.
 */
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    console.log(`BillAlert: alarm fired — ${alarm.name}`);
    scanGmail();
  }
});

// ─── Message listener (from popup) ───────────────────────────────────────────

/**
 * Listens for messages sent by popup.js via chrome.runtime.sendMessage.
 *
 * Supported actions:
 *  - { action: "scanNow" }                   → run Gmail scan immediately
 *  - { action: "updateAlarms", times: [...] } → recreate alarms for new times
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'scanNow') {
    console.log('BillAlert: received scanNow from popup');
    // Run async scan; respond when done.
    scanGmail()
      .then(() => sendResponse({ success: true }))
      .catch(err => {
        console.error('BillAlert: scanNow failed', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep the message channel open for the async response.
  }

  if (message.action === 'updateAlarms') {
    const times = message.times || [];
    console.log('BillAlert: received updateAlarms', times);
    recreateAlarms(times)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ─── Core scan function ───────────────────────────────────────────────────────

/**
 * Main workflow: fetch Gmail emails → send to backend → save results → notify.
 *
 * This function is safe to call multiple times concurrently; each invocation
 * is independent.
 */
async function scanGmail() {
  console.log('BillAlert: starting Gmail scan');

  // ── Step 1: Retrieve stored auth token ────────────────────────────────────
  // getStoredToken() is provided by auth.js.
  // For now, fall back to reading from storage directly until auth.js is wired.
  let authToken = null;
  try {
    // Use BillAlertAuth.getToken() from auth.js (handles refresh automatically)
    if (globalThis.BillAlertAuth && typeof globalThis.BillAlertAuth.getToken === 'function') {
      authToken = await globalThis.BillAlertAuth.getToken();
    } else {
      const data = await chromeStorageGet('authToken');
      authToken  = data.authToken || null;
    }
  } catch (e) {
    console.warn('BillAlert: could not retrieve auth token', e);
  }

  if (!authToken) {
    console.log('BillAlert: no auth token — skipping scan');
    return;
  }

  // ── Step 2: Fetch bill-related emails from Gmail API ──────────────────────
  let emails;
  try {
    emails = await fetchBillEmails(authToken);
  } catch (err) {
    if (err.status === 401) {
      // Token has expired — clear it and ask the user to sign in again.
      await handleTokenExpiry();
      return;
    }
    console.error('BillAlert: Gmail fetch error', err);
    return;
  }

  if (!emails || emails.length === 0) {
    console.log('BillAlert: no matching emails found');
    return;
  }

  console.log(`BillAlert: found ${emails.length} matching email(s)`);

  // ── Step 3: Get user ID to send to backend ────────────────────────────────
  // getUserId() should return a hashed identifier — provided by auth.js.
  let userId = 'unknown';
  try {
    if (globalThis.BillAlertAuth && typeof globalThis.BillAlertAuth.getUserId === 'function') {
      userId = await globalThis.BillAlertAuth.getUserId() || 'unknown';
    } else {
      const data = await chromeStorageGet('userId');
      userId = data.userId || 'unknown';
    }
  } catch (e) {
    console.warn('BillAlert: could not get userId', e);
  }

  // ── Step 4: POST emails to backend for AI summarisation ───────────────────
  let bills;
  try {
    bills = await summariseWithBackend(userId, emails);
  } catch (err) {
    console.error('BillAlert: backend summarise error', err);
    return;
  }

  if (!bills || bills.length === 0) {
    console.log('BillAlert: backend returned no bills');
    return;
  }

  // ── Step 5: Save results to local storage ─────────────────────────────────
  await chrome.storage.local.set({ billSummary: bills });
  console.log(`BillAlert: saved ${bills.length} bill(s) to storage`);

  // ── Step 6: Fire browser notification ─────────────────────────────────────
  await fireNotification(bills);
}

// ─── Gmail API helpers ────────────────────────────────────────────────────────

/**
 * Fetches up to MAX_EMAILS message summaries matching GMAIL_QUERY.
 * Returns an array of { id, subject, snippet, from, date } objects.
 *
 * @param {string} token - Valid OAuth2 access token
 * @returns {Promise<Array>}
 */
async function fetchBillEmails(token) {
  // First, search for matching message IDs.
  const searchUrl = new URL(`${GMAIL_API_BASE}/messages`);
  searchUrl.searchParams.set('q',          GMAIL_QUERY);
  searchUrl.searchParams.set('maxResults', String(MAX_EMAILS));

  const searchRes = await gmailFetch(searchUrl.toString(), token);

  if (!searchRes.messages || searchRes.messages.length === 0) {
    return [];
  }

  // Fetch each message's metadata in parallel (subject, from, date, snippet).
  const messagePromises = searchRes.messages.map(({ id }) =>
    fetchEmailMetadata(id, token)
  );

  const results = await Promise.allSettled(messagePromises);

  // Filter out any that failed and return the successful ones.
  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
}

/**
 * Fetches metadata for a single Gmail message.
 * Returns { id, subject, snippet, from, date } or null on error.
 *
 * @param {string} messageId - Gmail message ID
 * @param {string} token     - OAuth2 access token
 */
async function fetchEmailMetadata(messageId, token) {
  const url = `${GMAIL_API_BASE}/messages/${messageId}?format=metadata` +
              `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;

  try {
    const data = await gmailFetch(url, token);

    // Extract headers into a convenient map.
    const headers = {};
    (data.payload?.headers || []).forEach(h => {
      headers[h.name.toLowerCase()] = h.value;
    });

    return {
      id:      data.id,
      subject: headers['subject'] || '(no subject)',
      snippet: data.snippet       || '',
      from:    headers['from']    || '',
      date:    headers['date']    || '',
    };
  } catch (err) {
    console.warn(`BillAlert: failed to fetch message ${messageId}`, err);
    return null;
  }
}

/**
 * Performs an authenticated GET request to the Gmail API.
 * Throws an error object with { status } on HTTP errors.
 *
 * @param {string} url   - Full Gmail API URL
 * @param {string} token - OAuth2 access token
 */
async function gmailFetch(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const err    = new Error(`Gmail API error: ${response.status}`);
    err.status   = response.status;
    throw err;
  }

  return response.json();
}

// ─── Backend helpers ──────────────────────────────────────────────────────────

/**
 * Sends extracted email data to the BillAlert backend for AI summarisation.
 * Returns the array of bill objects: [{ payee, amount, dueDate, confidence }]
 *
 * @param {string} userId - Hashed user identifier
 * @param {Array}  emails - Array of { id, subject, snippet, from, date }
 */
async function summariseWithBackend(userId, emails) {
  const response = await fetch(`${BACKEND_URL}/summarize`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key':    EXTENSION_API_KEY,
    },
    body: JSON.stringify({ userId, emails }),
  });

  if (!response.ok) {
    throw new Error(`Backend error: ${response.status}`);
  }

  const data = await response.json();
  return data.bills || [];
}

// ─── Notification helper ──────────────────────────────────────────────────────

/**
 * Fires a Chrome browser notification summarising the upcoming bills.
 * Shows the first 3 bills; remaining count mentioned if more exist.
 *
 * @param {Array} bills - Array of { payee, amount, dueDate, confidence }
 */
async function fireNotification(bills) {
  // Build a short summary string for the notification body.
  const displayed = bills.slice(0, 3);
  const lines     = displayed.map(b => {
    const amount = b.amount ? ` — $${b.amount}` : '';
    const due    = b.dueDate ? ` (due ${b.dueDate})` : '';
    return `${b.payee}${amount}${due}`;
  });

  if (bills.length > 3) {
    lines.push(`…and ${bills.length - 3} more`);
  }

  chrome.notifications.create({
    type:    'basic',
    iconUrl: 'icons/icon128.png',
    title:   `BillAlert: ${bills.length} upcoming bill${bills.length !== 1 ? 's' : ''}`,
    message: lines.join('\n'),
  });
}

// ─── Token expiry handler ─────────────────────────────────────────────────────

/**
 * Called when the Gmail API returns a 401 Unauthorized response.
 * Clears the stored token and notifies the user to sign in again.
 */
async function handleTokenExpiry() {
  console.warn('BillAlert: auth token expired — clearing');

  // Sign out via BillAlertAuth to fully revoke token.
  if (globalThis.BillAlertAuth && typeof globalThis.BillAlertAuth.signOut === 'function') {
    await globalThis.BillAlertAuth.signOut();
  } else {
    await chrome.storage.local.remove('authToken');
  }

  // Let the user know they need to re-authenticate.
  chrome.notifications.create({
    type:    'basic',
    iconUrl: 'icons/icon128.png',
    title:   'BillAlert: Please sign in again',
    message: 'Your session has expired. Open BillAlert to reconnect your Google account.',
  });
}

// ─── Utility: Chrome storage wrapper ─────────────────────────────────────────

/** Promise-wrapper around chrome.storage.local.get */
function chromeStorageGet(keys) {
  return new Promise(resolve =>
    chrome.storage.local.get(keys, resolve)
  );
}
