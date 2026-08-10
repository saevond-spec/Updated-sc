import dotenv from 'dotenv';
dotenv.config();

// --- User Access Token state ---
let accessToken = null;
let refreshToken = null;
let tokenExpiration = 0;
let refreshPromise = null;

// --- App Access Token state ---
let appToken = null;
let appTokenExpiration = 0;

let storage = null;

// Timeout for all OAuth API requests (milliseconds)
const REQUEST_TIMEOUT_MS = 10000; // 10 seconds

/**
 * Helper to perform a fetch with a timeout.
 * Aborts the request if it takes longer than REQUEST_TIMEOUT_MS.
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }
}

function requireClientCredentials() {
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET environment variables are required.');
  }
}

/**
 * Initialize the token manager with a persistent storage backend.
 * Must be called before any token operations.
 * @param {Object} storageInstance - Storage instance with getTokens/setTokens methods.
 */
export function initTokenManager(storageInstance) {
  storage = storageInstance;
  console.log('[TokenManager] Storage instance set, configured =', storage?.configured);
}

/**
 * Load tokens from Redis or TWITCH_REFRESH_TOKEN env var.
 * Immediately validates by performing a refresh.
 * @returns {Promise<boolean>} True if a valid token was obtained.
 */
export async function loadTokens() {
  console.log('[TokenManager] loadTokens() called');
  console.log('[TokenManager] storage.configured =', storage?.configured);

  // Try Redis first
  if (storage?.configured) {
    try {
      console.log('[TokenManager] Attempting to load tokens from Redis...');
      const stored = await storage.getTokens();
      console.log('[TokenManager] getTokens result:', stored ? 'data received' : 'null/undefined');
      if (stored?.refreshToken) {
        console.log('[TokenManager] Loaded refresh token from Redis (first 10 chars):', stored.refreshToken.substring(0, 10) + '...');
        refreshToken = stored.refreshToken;
        try {
          await refreshAccessToken();
          console.log('[TokenManager] Successfully refreshed token from stored refresh token');
          return true;
        } catch (err) {
          console.error('[TokenManager] Stored refresh token is invalid:', err.message);
          refreshToken = null;
        }
      } else {
        console.log('[TokenManager] No refresh token found in Redis (stored object missing refreshToken)');
      }
    } catch (err) {
      console.error('[TokenManager] Failed to load tokens from Redis:', err.message);
    }
  } else {
    console.log('[TokenManager] Storage not configured or disabled – skipping Redis load');
  }

  // Fallback: bootstrap from env var
  if (process.env.TWITCH_REFRESH_TOKEN) {
    console.log('[TokenManager] Bootstrapping from TWITCH_REFRESH_TOKEN env var');
    refreshToken = process.env.TWITCH_REFRESH_TOKEN;
    try {
      await refreshAccessToken();
      console.log('[TokenManager] Successfully refreshed token from env var');
      return true;
    } catch (err) {
      console.error('[TokenManager] Env var refresh token is invalid:', err.message);
      refreshToken = null;
      return false;
    }
  }

  console.log('[TokenManager] No tokens found. Authorization required via /auth/setup');
  return false;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * Called from the /auth/callback Express route.
 * @param {string} code - Authorization code from Twitch redirect.
 * @param {string} redirectUri - The redirect URI used in the auth request.
 * @param {string} [expectedUsername] - Optional: validate the token belongs to this username.
 * @returns {Promise<Object>} Full token response from Twitch.
 */
export async function exchangeCodeForTokens(code, redirectUri, expectedUsername) {
  requireClientCredentials();

  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await fetchWithTimeout('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: params,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  }

  // Validate that the authorized account matches the expected bot username
  if (expectedUsername) {
    const validateResponse = await fetchWithTimeout('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${data.access_token}` },
    });

    if (!validateResponse.ok) {
      throw new Error('Failed to validate the received access token.');
    }

    const validateData = await validateResponse.json();
    const authorizedLogin = (validateData.login || '').toLowerCase();
    const expected = expectedUsername.toLowerCase();

    if (authorizedLogin !== expected) {
      // Revoke the token immediately — don't leave a dangling authorization
      await fetchWithTimeout(
        `https://id.twitch.tv/oauth2/revoke?client_id=${process.env.TWITCH_CLIENT_ID}&token=${data.access_token}`,
        { method: 'POST' }
      ).catch(() => {});

      throw new Error(
        `Authorization rejected: expected bot account "${expected}" but got "${authorizedLogin}". ` +
        `Please log into the correct Twitch account and try again.`
      );
    }

    console.log(`[TokenManager] Verified token belongs to: ${authorizedLogin}`);
  }

  accessToken = data.access_token;
  refreshToken = data.refresh_token;
  tokenExpiration = Date.now() + data.expires_in * 1000;

  console.log('[TokenManager] About to persist tokens after exchange...');
  await persistTokens();
  console.log('[TokenManager] Authorization complete. Tokens stored.');

  return data;
}

/**
 * Get a valid user access token, refreshing automatically if expired.
 * Used for IRC auth and user-scoped Helix calls.
 * @returns {Promise<string>} A valid user access token.
 */
export async function getUserToken() {
  if (!refreshToken) {
    throw new Error('Not authorized. Visit /auth/setup to connect the bot Twitch account.');
  }

  // Return cached token if still valid (5-minute buffer)
  if (accessToken && Date.now() < tokenExpiration - 300000) {
    return accessToken;
  }

  return refreshAccessToken();
}

/**
 * Get a valid app access token via client credentials grant.
 * Used specifically for sendChatMessage to preserve bot badge behavior.
 * @returns {Promise<string>} A valid app access token.
 */
export async function getAppToken() {
  if (appToken && Date.now() < appTokenExpiration - 300000) {
    return appToken;
  }

  requireClientCredentials();
  console.log('[TokenManager] Fetching App Access Token...');

  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID,
    client_secret: process.env.TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });

  const response = await fetchWithTimeout('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: params,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to get app token: ${JSON.stringify(data)}`);
  }

  appToken = data.access_token;
  appTokenExpiration = Date.now() + data.expires_in * 1000;

  return appToken;
}

/**
 * Check whether the bot has been authorized (has a refresh token).
 * @returns {boolean}
 */
export function isAuthorized() {
  return !!refreshToken;
}

/**
 * Force a user token refresh. Called reactively when a 401 is received.
 * @returns {Promise<string>} The new access token.
 */
export async function forceRefresh() {
  tokenExpiration = 0;
  return refreshAccessToken();
}

/**
 * Invalidate the cached app token so the next getAppToken() call fetches a new one.
 */
export function invalidateAppToken() {
  appToken = null;
  appTokenExpiration = 0;
}

/**
 * Refresh the user access token using the stored refresh token.
 * Serialized: concurrent callers share a single in-flight request.
 * @returns {Promise<string>} The new access token.
 *
 * Error handling:
 * - If Twitch returns 400 with "invalid_grant", the refresh token is dead.
 *   We clear it and throw so the caller knows re-authorization is required.
 * - For any other error (network, 5xx, timeout), we keep the old token
 *   and throw, so the caller can retry later.
 */
async function refreshAccessToken() {
  // If a refresh is already in-flight, piggyback on it
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      requireClientCredentials();
      console.log('[TokenManager] Refreshing user access token...');

      const params = new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });

      const response = await fetchWithTimeout('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        body: params,
      });

      const data = await response.json();

      if (!response.ok) {
        // Distinguish between a permanently invalid refresh token and a transient failure
        if (response.status === 400 && data.error === 'invalid_grant') {
          console.error('[TokenManager] Refresh token is invalid or revoked – manual re-authorization required.');
          // Clear the stale token so isAuthorized() returns false
          accessToken = null;
          refreshToken = null;
          tokenExpiration = 0;
          await persistTokens(); // persist the cleared state
          throw new Error('invalid_grant');
        }

        // For any other error (5xx, network, timeout), leave the existing token in place.
        console.warn('[TokenManager] Refresh attempt failed (transient?):', data.message || JSON.stringify(data));
        throw new Error(data.message || `Refresh failed with status ${response.status}`);
      }

      accessToken = data.access_token;
      refreshToken = data.refresh_token || refreshToken;
      tokenExpiration = Date.now() + data.expires_in * 1000;

      console.log(`[TokenManager] User token refreshed (expires in ${data.expires_in}s)`);
      await persistTokens();

      return accessToken;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * Persist current tokens to Redis for survival across restarts.
 */
async function persistTokens() {
  console.log('[TokenManager] persistTokens called, storage.configured =', storage?.configured);
  if (!storage?.configured) {
    console.log('[TokenManager] Storage not configured, skipping persist');
    return;
  }

  try {
    console.log('[TokenManager] Attempting to store tokens in Redis...');
    await storage.setTokens(accessToken, refreshToken, tokenExpiration);
    console.log('[TokenManager] Tokens stored successfully');
  } catch (err) {
    console.error('[TokenManager] Failed to persist tokens to Redis:', err.message);
  }
}
