import axios from 'axios';
import { config } from '../config/index.js';
import { getRedis } from '../storage/redis.js';
import { readJSON, writeJSON } from '../storage/file.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('AUTH');
const TOKEN_KEY = 'twitch:oauth';
const TOKEN_FILE = './tokens.json';
const REQUEST_TIMEOUT_MS = 10000;

let currentToken = null;
let refreshTimer = null;
let refreshPromise = null;   // concurrent refresh guard

const SCOPES = [
  'chat:read', 'chat:edit',
  'user:bot', 'user:read:chat', 'user:write:chat',
  'moderation:read', 'channel:manage:moderators',
  'moderator:read:followers',
  'moderator:manage:shoutouts',
];

async function loadStoredToken() {
  const redis = getRedis();
  if (redis) {
    try {
      const data = await redis.get(TOKEN_KEY);
      if (data) return JSON.parse(data);
    } catch (err) {
      log.warn('Failed to load token from Redis', err.message);
    }
  }
  return readJSON(TOKEN_FILE, null);
}

async function saveToken(tokenData) {
  const redis = getRedis();
  const expiresIn = tokenData.expires_in || 86400;
  if (redis) {
    try {
      await redis.set(TOKEN_KEY, JSON.stringify(tokenData), 'EX', expiresIn);
      log.debug('Token persisted to Redis');
    } catch (err) {
      log.warn('Failed to save token to Redis', err.message);
    }
  }
  try {
    await writeJSON(TOKEN_FILE, tokenData);
    log.debug('Token persisted to file');
  } catch (err) {
    log.warn('Failed to save token to file', err.message);
  }
}

export async function validateToken() {
  if (!currentToken) return false;
  try {
    await axios.get('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `OAuth ${currentToken.access_token}` },
      timeout: REQUEST_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    log.debug('Token validation failed', err.response?.status || err.message);
    return false;
  }
}

// FIXED: Only returns true if token is actually valid after refresh attempt
export async function initAuth() {
  const stored = await loadStoredToken();
  if (stored) {
    currentToken = stored;
    log.info('Token loaded from storage');

    const valid = await validateToken();
    if (!valid) {
      log.warn('Stored token invalid, attempting refresh...');
      try {
        await refreshToken();
        if (currentToken && await validateToken()) {
          scheduleRefresh();
          return true;
        }
      } catch (err) {
        log.error('Token refresh failed, auth not ready');
      }
      currentToken = null;
      return false;
    }

    // Token valid, near expiry?
    if (currentToken.expires_at && Date.now() >= currentToken.expires_at - 60000) {
      log.info('Token near expiry, refreshing...');
      await refreshToken().catch(err => log.error('Pre‑emptive refresh failed'));
    }
    scheduleRefresh();
    return true;
  }
  log.info('No token yet – waiting for OAuth');
  return false;
}

export async function exchangeCodeForToken(code, redirectUri) {
  const params = new URLSearchParams({
    client_id: config.twitch.clientId,
    client_secret: config.twitch.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await axios.post(
    'https://id.twitch.tv/oauth2/token',
    params.toString(),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  const tokenData = response.data;
  tokenData.expires_at = Date.now() + tokenData.expires_in * 1000;
  tokenData.scopes = SCOPES;
  currentToken = tokenData;
  await saveToken(tokenData);
  scheduleRefresh();
  log.info('Token exchanged successfully');
  return tokenData;
}

async function refreshToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    if (!currentToken) {
      refreshPromise = null;
      return;
    }

    const params = new URLSearchParams({
      client_id: config.twitch.clientId,
      client_secret: config.twitch.clientSecret,
      refresh_token: currentToken.refresh_token,
      grant_type: 'refresh_token',
    });

    try {
      const response = await axios.post(
        'https://id.twitch.tv/oauth2/token',
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: REQUEST_TIMEOUT_MS,
        }
      );

      const newData = response.data;
      if (newData.refresh_token) {
        currentToken.refresh_token = newData.refresh_token;
      }
      currentToken.access_token = newData.access_token;
      currentToken.expires_in = newData.expires_in;
      currentToken.expires_at = Date.now() + newData.expires_in * 1000;
      await saveToken(currentToken);
      log.info('Token refreshed successfully');
    } catch (err) {
      const status = err.response?.status;
      const errorCode = err.response?.data?.error;
      if (status === 400 && errorCode === 'invalid_grant') {
        log.error('Refresh token invalid or revoked – manual re-authorization required');
        currentToken = null;
        try {
          const redis = getRedis();
          if (redis) await redis.del(TOKEN_KEY);
          await writeJSON(TOKEN_FILE, null);
        } catch (e) { /* ignore */ }
        throw new Error('invalid_grant');
      } else {
        log.warn('Token refresh failed (transient)', err.response?.status || err.message);
        scheduleRefresh();
      }
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!currentToken || !currentToken.expires_at) return;
  const now = Date.now();
  const timeToExpiry = currentToken.expires_at - now;
  const refreshAt = Math.max(timeToExpiry - 60000, 60000);
  refreshTimer = setTimeout(async () => {
    try {
      await refreshToken();
    } catch (err) {
      if (err.message === 'invalid_grant') {
        log.error('Stopping refresh attempts – re-authorization needed');
        return;
      }
    }
    scheduleRefresh();
  }, refreshAt);
}

export function getAccessToken() {
  return currentToken?.access_token || null;
}

export function isAuthorized() {
  return !!getAccessToken();
}
