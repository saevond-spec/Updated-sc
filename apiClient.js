import { getUserToken, forceRefresh, getAppToken, invalidateAppToken } from './tokenManager.js';

const HELIX_API_BASE = 'https://api.twitch.tv/helix';

function requireClientId() {
    if (!process.env.TWITCH_CLIENT_ID) {
        throw new Error('TWITCH_CLIENT_ID environment variable is required.');
    }
}

function buildUrl(path, query = {}) {
    const url = new URL(`${HELIX_API_BASE}${path}`);

    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;

        if (Array.isArray(value)) {
            for (const item of value) {
                if (item !== undefined && item !== null && item !== '') {
                    url.searchParams.append(key, item);
                }
            }
        } else if (value !== '') {
            url.searchParams.append(key, value);
        }
    }

    return url;
}

async function parseResponseBody(response) {
    const text = await response.text();
    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Central Helix API request handler with automatic 401 retry.
 * @param {string} path - Helix endpoint path (e.g. '/users')
 * @param {Object} options
 * @param {string} options.method - HTTP method
 * @param {Object} options.query - Query parameters
 * @param {Object} options.body - JSON body
 * @param {boolean} options.retry - Whether to retry on 401
 * @param {boolean} options.useAppToken - Use app access token instead of user token
 */
async function helixRequest(path, { method = 'GET', query = {}, body = null, retry = true, useAppToken = false } = {}) {
    requireClientId();

    const token = useAppToken ? await getAppToken() : await getUserToken();
    const url = buildUrl(path, query);

    const response = await fetch(url, {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Client-Id': process.env.TWITCH_CLIENT_ID,
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
    });

    const data = await parseResponseBody(response);

    if (response.status === 401 && retry) {
        console.warn(`[Twitch API] 401 on ${method} ${path}. Refreshing token and retrying once...`);
        if (useAppToken) {
            invalidateAppToken();
        } else {
            await forceRefresh();
        }
        return helixRequest(path, { method, query, body, retry: false, useAppToken });
    }

    if (!response.ok) {
        throw new Error(`Twitch API ${method} ${path} failed (${response.status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    }

    return data;
}

/**
 * Fetches User IDs for a list of usernames.
 * @param {string[]} usernames - Array of usernames to resolve.
 * @returns {Promise<Object>} Map of username (lowercase) -> numeric ID.
 */
export async function getHelixIds(usernames) {
    if (!usernames || usernames.length === 0) return {};

    const cleanUsernames = [...new Set(
        usernames
            .map(user => String(user).replace('#', '').trim().toLowerCase())
            .filter(Boolean)
    )];

    if (cleanUsernames.length === 0) return {};

    const data = await helixRequest('/users', {
        query: { login: cleanUsernames }
    });

    const idMap = {};

    for (const user of data?.data || []) {
        idMap[user.login.toLowerCase()] = user.id;
    }

    return idMap;
}

/**
 * Fetches channel information including live status and stream title.
 * @param {string} broadcasterId - The broadcaster ID to fetch info for.
 * @returns {Promise<Object|null>} Object containing channelName, title, isLive, or null if not found.
 */
export async function getChannelInfo(broadcasterId) {
    const channelData = await helixRequest('/channels', {
        query: { broadcaster_id: broadcasterId }
    });

    const channelInfo = channelData?.data?.[0];
    if (!channelInfo) {
        return null;
    }

    const streamData = await helixRequest('/streams', {
        query: { user_id: broadcasterId }
    });

    return {
        channelName: channelInfo.broadcaster_login,
        title: channelInfo.title,
        isLive: Array.isArray(streamData?.data) && streamData.data.length > 0
    };
}

/**
 * Sends a chat message via Helix API using an App Access Token.
 * App token is required (not user token) to preserve the bot chat badge.
 * @param {string} broadcasterId - The ID of the channel to send to.
 * @param {string} senderId - The ID of the bot sending the message.
 * @param {string} message - The message content.
 * @returns {Promise<Object>} Twitch response payload for the sent message.
 */
export async function sendChatMessage(broadcasterId, senderId, message) {
    const data = await helixRequest('/chat/messages', {
        method: 'POST',
        body: {
            broadcaster_id: broadcasterId,
            sender_id: senderId,
            message
        },
        useAppToken: true
    });

    const result = data?.data?.[0];

    if (!result) {
        throw new Error('Twitch chat API returned no result.');
    }

    if (!result.is_sent) {
        throw new Error(`Twitch rejected chat message: ${JSON.stringify(result.drop_reason || {})}`);
    }

    return result;
}