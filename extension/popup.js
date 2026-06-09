/**
 * popup.js — BillAlert Chrome Extension
 *
 * Controls the popup UI. Handles:
 *  - Showing the sign-in or signed-in view based on auth state
 *  - Displaying stored bill summaries from chrome.storage.local
 *  - Tabs: "Upcoming" (unpaid) and "Paid" (persistent history)
 *  - Letting users pick notification times and persisting them
 *  - Triggering an immediate Gmail scan via the background service worker
 *
 * Storage keys:
 *  billSummary       — written by background.js after each scan (unpaid bills)
 *  paidBillsHistory  — written by popup.js; full bill objects marked as paid
 *                      NEVER overwritten by scans, so paid status persists
 */

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function authSignIn()   { return globalThis.BillAlertAuth ? globalThis.BillAlertAuth.signIn()  : Promise.resolve({ success: false }); }
function authSignOut()  { return globalThis.BillAlertAuth ? globalThis.BillAlertAuth.signOut() : Promise.resolve({ success: false }); }
function authGetToken() { return globalThis.BillAlertAuth ? globalThis.BillAlertAuth.getToken() : Promise.resolve(null); }
async function authGetEmail() {
  const data = await new Promise(r => chrome.storage.local.get('userEmail', r));
  return data.userEmail || null;
}

// ─── Element references (initialised inside DOMContentLoaded) ─────────────────
let viewSignedOut, viewSignedIn, elBtnSignIn, elBtnSignOut, userEmailEl,
    elBtnScanNow, scanSpinner, billList, noBillsMsg,
    paidBillList, noPaidMsg,
    timeList, inputNewTime, elBtnAddTime, statusBar, statusMessage;

// ─── Initialisation ──────────────────────────────────────────────────────────

async function init() {
  const data = await new Promise(r => chrome.storage.local.get(['signedIn', 'authToken'], r));
  if (data.signedIn && data.authToken) {
    await showSignedInView();
  } else {
    showSignedOutView();
  }
}

// ─── View helpers ─────────────────────────────────────────────────────────────

function showSignedOutView() {
  viewSignedOut.hidden = false;
  viewSignedIn.hidden  = true;
}

async function showSignedInView() {
  viewSignedOut.hidden = true;
  viewSignedIn.hidden  = false;

  const email = await authGetEmail();
  userEmailEl.textContent = email || 'your account';

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
 * Loads billSummary (from last scan) and paidBillsHistory (persistent),
 * then renders both tabs.
 *
 * Key design: paidBillsHistory is NEVER wiped by a scan. Bills marked paid
 * stay in the Paid tab permanently until the user clicks "Undo".
 */
async function loadBillSummary() {
  const data = await chromeStorageGet(['billSummary', 'paidBillsHistory']);
  const allBills   = data.billSummary       || [];
  const paidBills  = data.paidBillsHistory  || [];

  // Build a set of paid payees for fast lookup.
  // We match on payee name (lowercased) to survive minor AI phrasing differences.
  const paidPayees = new Set(paidBills.map(b => normPayee(b.payee)));

  // Upcoming = bills from scan that are NOT already in paid history.
  const upcomingBills = allBills.filter(b => !paidPayees.has(normPayee(b.payee)));

  renderUpcoming(upcomingBills);
  renderPaid(paidBills);
}

/** Normalises a payee string for fuzzy matching. */
function normPayee(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Marks a bill as paid:
 *  - Adds full bill object to paidBillsHistory (with timestamp)
 *  - Re-renders both tabs
 */
async function markBillPaid(bill) {
  const data = await chromeStorageGet('paidBillsHistory');
  const history = data.paidBillsHistory || [];

  // Avoid duplicates.
  if (!history.some(b => normPayee(b.payee) === normPayee(bill.payee))) {
    history.push({ ...bill, paidAt: new Date().toISOString() });
  }

  await chromeStorageSet({ paidBillsHistory: history });
  await loadBillSummary();
}

/**
 * Removes a bill from paid history (undo paid).
 */
async function unmarkBillPaid(payee) {
  const data = await chromeStorageGet('paidBillsHistory');
  const history = (data.paidBillsHistory || [])
    .filter(b => normPayee(b.payee) !== normPayee(payee));
  await chromeStorageSet({ paidBillsHistory: history });
  await loadBillSummary();
}

// ─── Render helpers ───────────────────────────────────────────────────────────

/** Renders the Upcoming (unpaid) tab. */
function renderUpcoming(bills) {
  billList.innerHTML = '';

  if (!bills || bills.length === 0) {
    noBillsMsg.hidden = false;
    billList.hidden   = true;
    return;
  }

  noBillsMsg.hidden = true;
  billList.hidden   = false;

  bills.forEach(bill => billList.appendChild(buildBillItem(bill, false)));
}

/** Renders the Paid tab. */
function renderPaid(paidBills) {
  paidBillList.innerHTML = '';

  if (!paidBills || paidBills.length === 0) {
    noPaidMsg.hidden    = false;
    paidBillList.hidden = true;
    return;
  }

  noPaidMsg.hidden    = true;
  paidBillList.hidden = false;

  // Show most recently paid first.
  const sorted = [...paidBills].sort((a, b) =>
    (b.paidAt || '').localeCompare(a.paidAt || '')
  );

  sorted.forEach(bill => paidBillList.appendChild(buildBillItem(bill, true)));
}

/**
 * Builds a single bill <li> element.
 * @param {Object}  bill   - Bill data
 * @param {boolean} isPaid - Whether this is in the paid tab
 */
function buildBillItem(bill, isPaid) {
  const li = document.createElement('li');
  li.className = `bill-item${isPaid ? ' paid' : ''}`;
  li.setAttribute('role', 'listitem');

  const amountText = bill.amount   ? formatCurrency(bill.amount) : 'Amount unknown';
  const dueDateText = bill.dueDate ? formatDueDate(bill.dueDate)  : 'Due date unknown';

  // Confidence: backend returns 0.0–1.0 number
  const confidenceLabel = typeof bill.confidence === 'number'
    ? (bill.confidence >= 0.7 ? 'high' : bill.confidence >= 0.4 ? 'medium' : 'low')
    : (bill.confidence || 'low').toLowerCase();
  const confidenceClass = `confidence-${confidenceLabel}`;

  // Show paid date in the paid tab
  const paidDateText = isPaid && bill.paidAt
    ? `Paid ${formatPaidDate(bill.paidAt)}`
    : '';

  const gmailLink = bill.emailId
    ? `<a class="bill-email-link" href="https://mail.google.com/mail/u/0/#inbox/${bill.emailId}" target="_blank" title="View email">✉</a>`
    : '';

  li.innerHTML = `
    <div class="bill-info">
      <div class="bill-payee-row">
        <span class="bill-payee">${escapeHtml(bill.payee || 'Unknown Payee')}</span>
        ${gmailLink}
      </div>
      <div class="bill-meta">
        <span class="bill-amount">${amountText}</span>
        <span class="bill-due">${isPaid ? paidDateText : dueDateText}</span>
      </div>
      <span class="bill-confidence ${confidenceClass}" title="Detection confidence">
        ${confidenceLabel}
      </span>
    </div>
    <button class="${isPaid ? 'btn-undo-paid' : 'btn-mark-paid'}"
            data-payee="${escapeHtml(bill.payee || '')}">
      ${isPaid ? '↩ Undo' : '✓ Paid'}
    </button>
  `;

  const btn = li.querySelector(isPaid ? '.btn-undo-paid' : '.btn-mark-paid');
  btn.addEventListener('click', () => {
    isPaid ? unmarkBillPaid(bill.payee) : markBillPaid(bill);
  });

  return li;
}

// ─── Tab switching ────────────────────────────────────────────────────────────

function initTabs() {
  const tabBtns     = document.querySelectorAll('.tab-btn');
  const tabUpcoming = document.getElementById('tab-upcoming');
  const tabPaid     = document.getElementById('tab-paid');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const target = btn.dataset.tab;
      tabUpcoming.hidden = (target !== 'upcoming');
      tabPaid.hidden     = (target !== 'paid');
    });
  });
}

// ─── Scan Now ─────────────────────────────────────────────────────────────────

async function handleScanNow() {
  if (scanSpinner) scanSpinner.hidden = false;
  if (elBtnScanNow) elBtnScanNow.disabled = true;

  try {
    await sendMessageToBackground({ action: 'scanNow' });
    await sleep(3000);
    await loadBillSummary();
    showStatus('Scan complete!', 'success');
  } catch (err) {
    console.error('BillAlert: scan error', err);
    showStatus('Scan failed. Check your connection and try again.', 'error');
  } finally {
    if (scanSpinner) scanSpinner.hidden = true;
    if (elBtnScanNow) elBtnScanNow.disabled = false;
  }
}

// ─── Notification Times ───────────────────────────────────────────────────────

async function loadNotificationTimes() {
  const data  = await chromeStorageGet('notificationTimes');
  const times = data.notificationTimes || ['09:00'];
  renderTimeChips(times);
}

function renderTimeChips(times) {
  timeList.innerHTML = '';
  times.forEach(time => {
    const li = document.createElement('li');
    li.className = 'time-chip';

    const label = document.createElement('span');
    label.className   = 'time-chip-label';
    label.textContent = formatTime12h(time);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'time-chip-remove';
    removeBtn.setAttribute('aria-label', `Remove ${formatTime12h(time)} reminder`);
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => removeNotificationTime(time));

    li.appendChild(label);
    li.appendChild(removeBtn);
    timeList.appendChild(li);
  });
}

async function handleAddTime() {
  const newTime = inputNewTime.value;
  if (!newTime) {
    showStatus('Please select a valid time.', 'error');
    return;
  }

  const data  = await chromeStorageGet('notificationTimes');
  const times = data.notificationTimes || ['09:00'];

  if (times.includes(newTime)) {
    showStatus(`${formatTime12h(newTime)} is already added.`, 'info');
    return;
  }

  const updated = [...times, newTime].sort();
  await saveNotificationTimes(updated);
  renderTimeChips(updated);
  showStatus(`Reminder set for ${formatTime12h(newTime)}.`, 'success');
}

async function removeNotificationTime(timeToRemove) {
  const data  = await chromeStorageGet('notificationTimes');
  const times = (data.notificationTimes || ['09:00'])
    .filter(t => t !== timeToRemove);

  if (times.length === 0) {
    showStatus('You need at least one reminder time.', 'error');
    return;
  }

  await saveNotificationTimes(times);
  renderTimeChips(times);
  showStatus(`Removed ${formatTime12h(timeToRemove)} reminder.`, 'info');
}

async function saveNotificationTimes(times) {
  await chromeStorageSet({ notificationTimes: times });
  await sendMessageToBackground({ action: 'updateAlarms', times });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function chromeStorageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function chromeStorageSet(items) {
  return new Promise(resolve => chrome.storage.local.set(items, resolve));
}

function sendMessageToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        console.warn('BillAlert: background message error', chrome.runtime.lastError);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

let statusTimeout = null;
function showStatus(msg, type = 'info') {
  if (statusTimeout) clearTimeout(statusTimeout);
  statusMessage.textContent = msg;
  statusBar.className = `status-bar status-${type}`;
  statusBar.hidden = false;
  statusTimeout = setTimeout(() => { statusBar.hidden = true; }, 3000);
}

function setButtonLoading(btn, isLoading, label) {
  btn.disabled    = isLoading;
  btn.textContent = label;
}

function formatDueDate(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  const now      = new Date();
  const diffDays = Math.ceil((date - now) / (1000 * 60 * 60 * 24));
  if (diffDays < 0)   return `Overdue by ${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? 's' : ''}`;
  if (diffDays === 0) return 'Due today';
  if (diffDays === 1) return 'Due tomorrow';
  return `Due in ${diffDays} days`;
}

function formatPaidDate(isoStr) {
  const date = new Date(isoStr);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatCurrency(amount) {
  const num = parseFloat(amount);
  if (isNaN(num)) return amount;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function formatTime12h(time24) {
  const [hourStr, minStr] = time24.split(':');
  let hour = parseInt(hourStr, 10);
  const min  = minStr || '00';
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${min} ${ampm}`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  viewSignedOut = document.getElementById('view-signed-out');
  viewSignedIn  = document.getElementById('view-signed-in');
  elBtnSignIn   = document.getElementById('btn-sign-in');
  elBtnSignOut  = document.getElementById('btn-sign-out');
  userEmailEl   = document.getElementById('user-email');
  elBtnScanNow  = document.getElementById('btn-scan-now');
  scanSpinner   = document.getElementById('scan-spinner');
  billList      = document.getElementById('bill-list');
  noBillsMsg    = document.getElementById('no-bills-msg');
  paidBillList  = document.getElementById('paid-bill-list');
  noPaidMsg     = document.getElementById('no-paid-msg');
  timeList      = document.getElementById('time-list');
  inputNewTime  = document.getElementById('input-new-time');
  elBtnAddTime  = document.getElementById('btn-add-time');
  statusBar     = document.getElementById('status-bar');
  statusMessage = document.getElementById('status-message');

  elBtnSignIn.addEventListener('click', handleSignIn);
  elBtnSignOut.addEventListener('click', handleSignOut);
  elBtnScanNow.addEventListener('click', handleScanNow);
  elBtnAddTime.addEventListener('click', handleAddTime);

  initTabs();

  showSignedOutView();
  init().catch(err => {
    console.error('BillAlert: init failed', err);
    showSignedOutView();
  });
});
