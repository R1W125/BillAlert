/**
 * popup.js — BillAlert Chrome Extension
 *
 * Controls the popup UI. Handles:
 *  - Showing the sign-in or signed-in view based on auth state
 *  - Displaying stored bill summaries from chrome.storage.local
 *  - Letting users pick notification times and persisting them
 *  - Triggering an immediate Gmail scan via the background service worker
 *
 * Auth functions (signIn, signOut, getStoredToken, getUserEmail) are
 * provided by auth.js which is loaded before this script.
 */

// ─── Auth helpers ─────────────────────────────────────────────────────────────
// Thin wrappers around globalThis.BillAlertAuth (loaded by auth.js).
function authSignIn()   { return globalThis.BillAlertAuth ? globalThis.BillAlertAuth.signIn()  : Promise.resolve({ success: false }); }
function authSignOut()  { return globalThis.BillAlertAuth ? globalThis.BillAlertAuth.signOut() : Promise.resolve({ success: false }); }
function authGetToken() { return globalThis.BillAlertAuth ? globalThis.BillAlertAuth.getToken() : Promise.resolve(null); }
async function authGetEmail() {
  const data = await new Promise(r => chrome.storage.local.get('userEmail', r));
  return data.userEmail || null;
}

// ─── Element shortcuts (initialised inside DOMContentLoaded) ─────────────────
let viewSignedOut, viewSignedIn, elBtnSignIn, elBtnSignOut, userEmailEl,
    elBtnScanNow, scanSpinner, billList, noBillsMsg, timeList,
    inputNewTime, elBtnAddTime, statusBar, statusMessage;

// ─── Initialisation ──────────────────────────────────────────────────────────

/**
 * Entry point: called when the popup DOM is ready.
 * Decides which view to show based on whether an auth token exists.
 */
async function init() {
  // Auth functions come from auth.js (Agent 3).
  // getStoredToken() resolves to a token string or null.
  const token = await authGetToken();

  if (token) {
    await showSignedInView();
  } else {
    showSignedOutView();
  }
}

// ─── View helpers ─────────────────────────────────────────────────────────────

/** Switch to the "not signed in" screen. */
function showSignedOutView() {
  viewSignedOut.hidden = false;
  viewSignedIn.hidden  = true;
}

/**
 * Switch to the "signed in" screen and populate data.
 * Loads the user's email, stored bill summaries, and notification times.
 */
async function showSignedInView() {
  viewSignedOut.hidden = true;
  viewSignedIn.hidden  = false;

  // Show the user's email address in the identity bar.
  // getUserEmail() is provided by auth.js.
  const email = await authGetEmail();
  userEmailEl.textContent = email || 'your account';

  // Load bills and reminder times from local storage.
  await loadBillSummary();
  await loadNotificationTimes();
}

// ─── Sign in / Sign out ───────────────────────────────────────────────────────

async function handleSignIn() {
  setButtonLoading(elBtnSignIn, true, 'Signing in…');
  try {
    await authSignIn();
    await showSignedInView();
    showStatus('Signed in successfully!', 'success');
  } catch (err) {
    console.error('BillAlert: sign-in error', err);
    showStatus('Sign-in failed. Please try again.', 'error');
  } finally {
    setButtonLoading(elBtnSignIn, false, 'Sign in with Google');
  }
}

async function handleSignOut() {
  await authSignOut();
  showSignedOutView();
  showStatus('Signed out.', 'info');
}

// ─── Bill Summary ─────────────────────────────────────────────────────────────

/**
 * Reads the "billSummary" key from chrome.storage.local and renders
 * bill cards in the list. The background service worker writes this
 * key after each successful Gmail scan.
 */
async function loadBillSummary() {
  const data = await chromeStorageGet('billSummary');
  const bills = data.billSummary || [];
  renderBillList(bills);
}

/**
 * Renders an array of bill objects as list items.
 * Each bill has: { payee, amount, dueDate, confidence }
 */
function renderBillList(bills) {
  // Clear previous content.
  billList.innerHTML = '';

  if (!bills || bills.length === 0) {
    noBillsMsg.hidden = false;
    billList.hidden   = true;
    return;
  }

  noBillsMsg.hidden = false; // keep hidden
  noBillsMsg.hidden = true;
  billList.hidden   = false;

  bills.forEach(bill => {
    const li = document.createElement('li');
    li.className = 'bill-item';
    li.setAttribute('role', 'listitem');

    // Format amount — show "Unknown" if not parsed
    const amountText = bill.amount
      ? formatCurrency(bill.amount)
      : 'Amount unknown';

    // Format due date — show friendly text
    const dueDateText = bill.dueDate
      ? formatDueDate(bill.dueDate)
      : 'Due date unknown';

    // Confidence badge (high / medium / low)
    const confidenceClass = `confidence-${(bill.confidence || 'low').toLowerCase()}`;

    li.innerHTML = `
      <div class="bill-payee">${escapeHtml(bill.payee || 'Unknown Payee')}</div>
      <div class="bill-meta">
        <span class="bill-amount">${amountText}</span>
        <span class="bill-due">${dueDateText}</span>
      </div>
      <span class="bill-confidence ${confidenceClass}" title="Detection confidence">
        ${(bill.confidence || 'low').toLowerCase()}
      </span>
    `;

    billList.appendChild(li);
  });
}

// ─── Scan Now ─────────────────────────────────────────────────────────────────

async function handleScanNow() {
  // Show the spinner while scanning.
  scanSpinner.hidden = false;
  elBtnScanNow.disabled = true;

  try {
    // Tell the background service worker to scan immediately.
    await sendMessageToBackground({ action: 'scanNow' });

    // The background worker updates chrome.storage.local when done.
    // Poll briefly then reload the bill list.
    await sleep(2000);
    await loadBillSummary();
    showStatus('Scan complete!', 'success');
  } catch (err) {
    console.error('BillAlert: scan error', err);
    showStatus('Scan failed. Check your connection and try again.', 'error');
  } finally {
    scanSpinner.hidden  = true;
    elBtnScanNow.disabled = false;
  }
}

// ─── Notification Times ───────────────────────────────────────────────────────

/** Reads stored notification times and renders them as removable chips. */
async function loadNotificationTimes() {
  const data  = await chromeStorageGet('notificationTimes');
  const times = data.notificationTimes || ['09:00'];
  renderTimeChips(times);
}

/**
 * Renders the current list of notification times as chips.
 * Each chip has a remove (×) button.
 */
function renderTimeChips(times) {
  timeList.innerHTML = '';

  times.forEach(time => {
    const li = document.createElement('li');
    li.className = 'time-chip';

    const label = document.createElement('span');
    label.className    = 'time-chip-label';
    label.textContent  = formatTime12h(time); // e.g. "9:00 AM"

    const removeBtn = document.createElement('button');
    removeBtn.className          = 'time-chip-remove';
    removeBtn.setAttribute('aria-label', `Remove ${formatTime12h(time)} reminder`);
    removeBtn.textContent        = '×';
    removeBtn.addEventListener('click', () => removeNotificationTime(time));

    li.appendChild(label);
    li.appendChild(removeBtn);
    timeList.appendChild(li);
  });
}

/** Adds a new notification time entered by the user. */
async function handleAddTime() {
  const newTime = inputNewTime.value; // "HH:MM" format
  if (!newTime) {
    showStatus('Please select a valid time.', 'error');
    return;
  }

  const data     = await chromeStorageGet('notificationTimes');
  const times    = data.notificationTimes || ['09:00'];

  // Prevent duplicate times.
  if (times.includes(newTime)) {
    showStatus(`${formatTime12h(newTime)} is already added.`, 'info');
    return;
  }

  const updated = [...times, newTime].sort();
  await saveNotificationTimes(updated);
  renderTimeChips(updated);
  showStatus(`Reminder set for ${formatTime12h(newTime)}.`, 'success');
}

/** Removes a specific notification time from the list. */
async function removeNotificationTime(timeToRemove) {
  const data  = await chromeStorageGet('notificationTimes');
  const times = (data.notificationTimes || ['09:00'])
    .filter(t => t !== timeToRemove);

  // Always keep at least one reminder.
  if (times.length === 0) {
    showStatus('You need at least one reminder time.', 'error');
    return;
  }

  await saveNotificationTimes(times);
  renderTimeChips(times);
  showStatus(`Removed ${formatTime12h(timeToRemove)} reminder.`, 'info');
}

/**
 * Persists notification times to storage and tells the background
 * worker to recreate its alarms to match.
 */
async function saveNotificationTimes(times) {
  await chromeStorageSet({ notificationTimes: times });
  // Update alarms in background service worker.
  await sendMessageToBackground({ action: 'updateAlarms', times });
}

// ─── Utility: Chrome storage wrappers ────────────────────────────────────────

/** Promise-wrapper around chrome.storage.local.get */
function chromeStorageGet(keys) {
  return new Promise(resolve =>
    chrome.storage.local.get(keys, resolve)
  );
}

/** Promise-wrapper around chrome.storage.local.set */
function chromeStorageSet(items) {
  return new Promise(resolve =>
    chrome.storage.local.set(items, resolve)
  );
}

// ─── Utility: Message background worker ──────────────────────────────────────

/**
 * Sends a message to the background service worker and returns the response.
 * Swallows "no receivers" errors gracefully (worker may be sleeping).
 */
function sendMessageToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        // Background worker may simply have no handler for this message.
        console.warn('BillAlert: background message error', chrome.runtime.lastError);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

// ─── Utility: Status bar ─────────────────────────────────────────────────────

let statusTimeout = null;

/**
 * Displays a transient status message at the bottom of the popup.
 * @param {string} msg   - Text to display
 * @param {'success'|'error'|'info'} type - Visual style
 */
function showStatus(msg, type = 'info') {
  if (statusTimeout) clearTimeout(statusTimeout);

  statusMessage.textContent = msg;
  statusBar.className = `status-bar status-${type}`;
  statusBar.hidden = false;

  // Auto-hide after 3 seconds.
  statusTimeout = setTimeout(() => {
    statusBar.hidden = true;
  }, 3000);
}

// ─── Utility: Button loading state ───────────────────────────────────────────

function setButtonLoading(btn, isLoading, label) {
  btn.disabled     = isLoading;
  btn.textContent  = label;
}

// ─── Utility: Formatters ─────────────────────────────────────────────────────

/** Formats an ISO date string into a friendly relative string, e.g. "Due in 3 days" */
function formatDueDate(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr; // fall back to raw string

  const now        = new Date();
  const diffMs     = date - now;
  const diffDays   = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0)   return `Overdue by ${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? 's' : ''}`;
  if (diffDays === 0) return 'Due today';
  if (diffDays === 1) return 'Due tomorrow';
  return `Due in ${diffDays} days`;
}

/** Formats a numeric amount as USD currency string, e.g. "$42.00" */
function formatCurrency(amount) {
  const num = parseFloat(amount);
  if (isNaN(num)) return amount;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

/**
 * Converts 24-hour "HH:MM" to 12-hour "H:MM AM/PM" display string.
 * @param {string} time24 - e.g. "09:00" or "14:30"
 */
function formatTime12h(time24) {
  const [hourStr, minStr] = time24.split(':');
  let hour = parseInt(hourStr, 10);
  const min  = minStr || '00';
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${min} ${ampm}`;
}

/** Escapes HTML special characters to prevent XSS from email content. */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Simple sleep helper used when waiting for background scan to finish. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Initialise element references now that the DOM is ready.
  viewSignedOut = document.getElementById('view-signed-out');
  viewSignedIn  = document.getElementById('view-signed-in');
  elBtnSignIn   = document.getElementById('btn-sign-in');
  elBtnSignOut  = document.getElementById('btn-sign-out');
  userEmailEl   = document.getElementById('user-email');
  elBtnScanNow  = document.getElementById('btn-scan-now');
  scanSpinner   = document.getElementById('scan-spinner');
  billList      = document.getElementById('bill-list');
  noBillsMsg    = document.getElementById('no-bills-msg');
  timeList      = document.getElementById('time-list');
  inputNewTime  = document.getElementById('input-new-time');
  elBtnAddTime  = document.getElementById('btn-add-time');
  statusBar     = document.getElementById('status-bar');
  statusMessage = document.getElementById('status-message');

  // Wire up button listeners now that elements exist.
  elBtnSignIn.addEventListener('click', handleSignIn);
  elBtnSignOut.addEventListener('click', handleSignOut);
  elBtnScanNow.addEventListener('click', handleScanNow);
  elBtnAddTime.addEventListener('click', handleAddTime);

  // Show signed-out view immediately, then check auth state.
  showSignedOutView();
  init().catch(err => {
    console.error('BillAlert: init failed', err);
    showSignedOutView();
  });
});
