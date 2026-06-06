/**
 * BillAlert Auth Module — auth.js
 *
 * Self-contained Gmail OAuth2 authentication module for the BillAlert Chrome
 * Extension (Manifest V3). Handles the full OAuth lifecycle: sign-in, sign-out,
 * token validation, silent refresh, and secure identity storage.
 *
 * Privacy guarantees enforced by this module:
 *   - The raw Google `sub` claim is NEVER stored. Only its SHA-256 hash is kept.
 *   - Auth tokens are stored exclusively in chrome.storage.local (sandboxed to
 *     this extension). They are NEVER sent to any third party — only to:
 *       • Google OAuth APIs (token validation/revocation)
 *       • Our own backend (userId hash only, not the token itself)
 *   - Gmail scope is strictly read-only: https://www.googleapis.com/auth/gmail.readonly
 *   - Token revocation at the Google authorization server is MANDATORY on sign-out.
 *
 * Exported as: window.BillAlertAuth (or globalThis.BillAlertAuth)
 * Compatible with both popup.js (window context) and background.js (service worker).
 */

'use strict';

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[BillAlert Auth]';

/** OAuth2 scopes requested. Kept minimal — read-only Gmail access only. */
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/** Google API endpoints used by this module. */
const GOOGLE_APIS = {
  userInfo:   'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
  tokenInfo:  'https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=',
  revoke:     'https://accounts.google.com/o/oauth2/revoke?token=',
};

/** chrome.storage.local keys managed by this module. */
const STORAGE_KEYS = {
  authToken:   'authToken',
  userEmail:   'userEmail',
  userId:      'userId',      // SHA-256 hash of Google sub — never the raw sub
  signedIn:    'signedIn',
  billSummary: 'billSummary', // cleared on sign-out (owned by other modules)
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Logs a message to the console with the [BillAlert Auth] prefix.
 * @param {string} message
 * @param {...*} args - Additional arguments forwarded to console.
 */
function log(_message, ..._args) {
  // Logging disabled in production
}

/**
 * Logs an error to the console with the [BillAlert Auth] prefix.
 * @param {string} message
 * @param {...*} args
 */
function logError(message, ...args) {
  console.error(`${LOG_PREFIX} ${message}`, ...args);
}

/**
 * Reads one or more keys from chrome.storage.local.
 * @param {string|string[]} keys
 * @returns {Promise<Object>}
 */
function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Writes key-value pairs to chrome.storage.local.
 * @param {Object} items
 * @returns {Promise<void>}
 */
function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Removes specified keys from chrome.storage.local.
 * @param {string[]} keys
 * @returns {Promise<void>}
 */
function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Wraps chrome.identity.getAuthToken in a Promise.
 * @param {Object} options - Passed directly to chrome.identity.getAuthToken.
 * @returns {Promise<string>} Resolves with the OAuth token string.
 */
function getAuthToken(options) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken(options, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error('No token returned by chrome.identity.getAuthToken'));
      } else {
        resolve(token);
      }
    });
  });
}

/**
 * Wraps chrome.identity.removeCachedAuthToken in a Promise.
 * @param {Object} options - Must include { token: string }.
 * @returns {Promise<void>}
 */
function removeCachedAuthToken(options) {
  return new Promise((resolve, reject) => {
    chrome.identity.removeCachedAuthToken(options, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Computes the SHA-256 hash of a string and returns it as a lowercase hex string.
 *
 * Privacy note: This is used to hash the Google `sub` claim so that the raw
 * Google identifier is never persisted to storage or sent to our backend.
 *
 * @param {string} input - The string to hash.
 * @returns {Promise<string>} Lowercase hex-encoded SHA-256 digest.
 */
async function sha256Hex(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initiates the interactive OAuth2 sign-in flow.
 *
 * Steps:
 *   1. Request an OAuth token interactively via chrome.identity.
 *   2. Fetch the Google userinfo endpoint to retrieve the user's email and sub.
 *   3. Hash the `sub` claim with SHA-256 — the raw sub is NEVER stored.
 *   4. Persist { authToken, userEmail, userId (hashed), signedIn } to
 *      chrome.storage.local.
 *
 * @returns {Promise<{success: boolean, userEmail?: string, userId?: string, error?: string}>}
 */
async function signIn() {
  try {
    log('Starting interactive sign-in…');

    // Step 1: Obtain OAuth token. The `interactive: true` flag shows the Google
    // consent screen if the user hasn't previously granted access.
    const token = await getAuthToken({ interactive: true, scopes: GMAIL_SCOPES });

    // Step 2: Fetch user profile. We only request the minimum needed fields.
    // The Authorization header keeps the token out of URL query parameters.
    const profileResponse = await fetch(GOOGLE_APIS.userInfo, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!profileResponse.ok) {
      throw new Error(
        `Failed to fetch user profile: HTTP ${profileResponse.status}`
      );
    }

    const profile = await profileResponse.json();

    // Validate that the response contains the fields we need.
    // Google's v1 userinfo endpoint may return either `sub` or `id` for the
    // unique account identifier depending on the token scopes granted.
    const accountId = profile.sub || profile.id;
    if (!accountId || !profile.email) {
      throw new Error(`User profile response missing required fields. Got: ${JSON.stringify(Object.keys(profile))}`);
    }

    // Step 3: Hash the account identifier immediately — never store the raw value.
    const userId = await sha256Hex(accountId);

    const userEmail = profile.email;

    // Step 4: Persist auth state. No raw sub is included here.
    await storageSet({
      [STORAGE_KEYS.authToken]:  token,
      [STORAGE_KEYS.userEmail]:  userEmail,
      [STORAGE_KEYS.userId]:     userId,   // SHA-256 hash only
      [STORAGE_KEYS.signedIn]:   true,
    });

    log(`Sign-in successful. User: ${userEmail} (userId: ${userId.slice(0, 8)}…)`);

    return { success: true, userEmail, userId };
  } catch (err) {
    logError('Sign-in failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Signs the user out and revokes the OAuth token.
 *
 * Steps:
 *   1. Remove the cached token from Chrome's identity store.
 *   2. Revoke the token at Google's authorization server (mandatory for privacy).
 *   3. Clear all auth-related keys from chrome.storage.local.
 *
 * Token revocation is best-effort: storage is always cleared regardless of
 * whether the revocation network request succeeds, so the user is always
 * considered signed out locally even if the revoke call fails (e.g. offline).
 *
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function signOut() {
  try {
    log('Starting sign-out…');

    // Step 1: Retrieve the current token so we can revoke it.
    const stored = await storageGet([STORAGE_KEYS.authToken]);
    const token = stored[STORAGE_KEYS.authToken];

    if (token) {
      // Step 2a: Remove the token from Chrome's in-memory identity cache.
      // This prevents chrome.identity from returning the stale token again
      // without going back to Google's servers.
      try {
        await removeCachedAuthToken({ token });
        log('Removed cached auth token from Chrome identity store.');
      } catch (cacheErr) {
        // Non-fatal: proceed to revoke server-side regardless.
        logError('Could not remove cached token (non-fatal):', cacheErr.message);
      }

      // Step 2b: Revoke the token at Google's authorization server.
      // Privacy: this invalidates the token server-side, ensuring it cannot be
      // used by anyone who may have obtained it — even temporarily.
      try {
        const revokeResponse = await fetch(`${GOOGLE_APIS.revoke}${token}`);
        if (revokeResponse.ok) {
          log('Token successfully revoked at Google authorization server.');
        } else {
          logError(
            `Token revocation returned non-OK status: ${revokeResponse.status} (continuing sign-out)`
          );
        }
      } catch (revokeErr) {
        // Non-fatal: still clear local storage. The token will expire naturally.
        logError('Token revocation network request failed (non-fatal):', revokeErr.message);
      }
    } else {
      log('No stored token found — proceeding to clear storage.');
    }

    // Step 3: Clear all auth-related keys. Also clears billSummary to avoid
    // showing stale data on the next sign-in.
    await storageRemove([
      STORAGE_KEYS.authToken,
      STORAGE_KEYS.userEmail,
      STORAGE_KEYS.userId,
      STORAGE_KEYS.signedIn,
      STORAGE_KEYS.billSummary,
    ]);

    log('Sign-out complete. Local auth state cleared.');
    return { success: true };
  } catch (err) {
    logError('Sign-out encountered an unexpected error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Returns a valid OAuth token, refreshing silently if necessary.
 *
 * Flow:
 *   1. Read the stored token from chrome.storage.local.
 *   2. If a token exists, validate it via the Google tokeninfo endpoint.
 *   3. If the token is expired/invalid, attempt a silent refresh via
 *      chrome.identity.getAuthToken({ interactive: false }).
 *   4. If the silent refresh fails (e.g. consent revoked), clear stored auth
 *      state and return null — the caller must trigger interactive re-auth.
 *
 * Callers should check for null and prompt the user to sign in again.
 *
 * @returns {Promise<string|null>} Valid OAuth token, or null if unavailable.
 */
async function getToken() {
  try {
    // Step 1: Read the token from storage.
    const stored = await storageGet([STORAGE_KEYS.authToken]);
    const storedToken = stored[STORAGE_KEYS.authToken];

    if (!storedToken) {
      log('getToken: No token in storage. Re-auth required.');
      return null;
    }

    // Step 2: Validate the stored token with a lightweight tokeninfo call.
    // This confirms the token is still active and hasn't been revoked externally.
    let tokenValid = false;
    try {
      const tokenInfoResponse = await fetch(
        `${GOOGLE_APIS.tokenInfo}${storedToken}`
      );
      if (tokenInfoResponse.ok) {
        const tokenInfo = await tokenInfoResponse.json();
        // `expires_in` is seconds remaining. A missing or non-positive value
        // means the token is expired.
        if (tokenInfo.expires_in && parseInt(tokenInfo.expires_in, 10) > 0) {
          tokenValid = true;
        } else {
          log('getToken: Stored token is expired (expires_in <= 0).');
        }
      } else {
        // HTTP 400 is the typical response for an invalid/expired token.
        log(`getToken: tokeninfo returned HTTP ${tokenInfoResponse.status} — token invalid.`);
      }
    } catch (validateErr) {
      // Network error during validation: treat as potentially invalid and try
      // a silent refresh to be safe.
      logError('getToken: Token validation request failed (will attempt refresh):', validateErr.message);
    }

    if (tokenValid) {
      return storedToken;
    }

    // Step 3: Token is expired or invalid — attempt a silent refresh.
    // `interactive: false` means no UI is shown; this succeeds only when Chrome
    // can automatically renew the token (e.g. user is still logged into Chrome).
    log('getToken: Attempting silent token refresh…');
    try {
      const freshToken = await getAuthToken({ interactive: false, scopes: GMAIL_SCOPES });

      // Persist the refreshed token so future calls don't need to re-fetch.
      await storageSet({ [STORAGE_KEYS.authToken]: freshToken });
      log('getToken: Silent refresh succeeded.');
      return freshToken;
    } catch (refreshErr) {
      // Step 4: Silent refresh failed. The user will need to sign in again.
      // Clear stored auth data so the app enters a clean unauthenticated state.
      logError('getToken: Silent refresh failed — clearing auth state:', refreshErr.message);
      await storageRemove([
        STORAGE_KEYS.authToken,
        STORAGE_KEYS.signedIn,
      ]);
      return null;
    }
  } catch (err) {
    logError('getToken: Unexpected error:', err.message);
    return null;
  }
}

/**
 * Checks whether the user is currently signed in.
 *
 * This reads the `signedIn` flag from chrome.storage.local. It does NOT
 * validate the token — use getToken() if you need a guaranteed-valid token.
 *
 * @returns {Promise<boolean>}
 */
async function isSignedIn() {
  try {
    const stored = await storageGet([STORAGE_KEYS.signedIn]);
    return stored[STORAGE_KEYS.signedIn] === true;
  } catch (err) {
    logError('isSignedIn: Error reading storage:', err.message);
    return false;
  }
}

/**
 * Returns the stored hashed user ID.
 *
 * This is the SHA-256 hash of the Google `sub` claim — never the raw identifier.
 * Used to identify the user when calling our backend API without exposing any
 * Google account information.
 *
 * @returns {Promise<string|null>} Hex-encoded SHA-256 hash, or null if not signed in.
 */
async function getUserId() {
  try {
    const stored = await storageGet([STORAGE_KEYS.userId]);
    return stored[STORAGE_KEYS.userId] || null;
  } catch (err) {
    logError('getUserId: Error reading storage:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

/**
 * Attach the public API to globalThis so it works in both:
 *   - Browser extension popup pages (window context)
 *   - Service workers / background.js (no `window` object)
 *
 * Usage in other extension scripts:
 *   const auth = globalThis.BillAlertAuth;
 *   const result = await auth.signIn();
 */
const BillAlertAuth = {
  signIn,
  signOut,
  getToken,
  isSignedIn,
  getUserId,
};

globalThis.BillAlertAuth = BillAlertAuth;
