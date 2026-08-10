// emote_providers.js
const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeEmoteToken(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  // Emotes must be a single token in Twitch chat (no spaces).
  if (/\s/.test(s)) return null;
  return s;
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }

    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/* ────────────────────────────────────────────────────────────────
 * 7TV
 * ──────────────────────────────────────────────────────────────── */

function extract7TvEmoteNamesFromEmoteSetPayload(payload) {
  const emotes = Array.isArray(payload?.emotes)
    ? payload.emotes
    : Array.isArray(payload?.data?.emotes)
      ? payload.data.emotes
      : [];

  const out = [];
  for (const emote of emotes) {
    const name = normalizeEmoteToken(emote?.name ?? emote?.data?.name);
    if (name) out.push(name);
  }
  return out;
}

async function fetch7TvEmoteSetById(emoteSetId, { timeoutMs } = {}) {
  const url = `https://7tv.io/v3/emote-sets/${encodeURIComponent(emoteSetId)}`;
  return await fetchJson(url, { timeoutMs });
}

async function fetch7TvGlobalEmotes({ timeoutMs } = {}) {
  const payload = await fetchJson('https://7tv.io/v3/emote-sets/global', { timeoutMs });
  return extract7TvEmoteNamesFromEmoteSetPayload(payload);
}

async function extract7TvNamesFromUserPayload(userData, { timeoutMs } = {}) {
  const setLike =
    userData?.emote_set ??
    userData?.connections?.find(c => c?.platform === 'TWITCH')?.emote_set ??
    null;

  if (setLike) {
    if (Array.isArray(setLike?.emotes)) {
      return setLike.emotes
        .map(e => normalizeEmoteToken(e?.name ?? e?.data?.name))
        .filter(Boolean);
    }

    if (setLike?.id) {
      try {
        const setPayload = await fetch7TvEmoteSetById(setLike.id, { timeoutMs });
        return extract7TvEmoteNamesFromEmoteSetPayload(setPayload);
      } catch {
        return [];
      }
    }
  }

  const maybeSetId = userData?.emote_set_id ?? userData?.emote_set?.id;
  if (maybeSetId) {
    try {
      const setPayload = await fetch7TvEmoteSetById(maybeSetId, { timeoutMs });
      return extract7TvEmoteNamesFromEmoteSetPayload(setPayload);
    } catch {
      return [];
    }
  }

  return [];
}

export async function fetchSevenTvGlobalEmotes(
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  return await fetch7TvGlobalEmotes({ timeoutMs });
}

export async function fetchSevenTvChannelEmotesForTwitchIds(
  twitchIds,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = 4
  } = {}
) {
  const results = new Map();
  const ids = [...new Set((twitchIds || []).map(String).filter(Boolean))];

  await mapLimit(ids, concurrency, async (id) => {
    try {
      const userData = await fetchJson(`https://7tv.io/v3/users/twitch/${encodeURIComponent(id)}`, { timeoutMs });
      const names = await extract7TvNamesFromUserPayload(userData, { timeoutMs });
      results.set(id, names);
    } catch (e) {
      console.error(`[7TV] Failed to fetch channel emotes for Twitch ID ${id}:`, e.message);
      results.set(id, []);
    }
  });

  return results;
}



/* ────────────────────────────────────────────────────────────────
 * BTTV
 * ──────────────────────────────────────────────────────────────── */

export async function fetchBttvGlobalEmotes(
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const out = new Set();
  const global = await fetchJson('https://api.betterttv.net/3/cached/emotes/global', { timeoutMs });
  for (const emote of global || []) {
    const code = normalizeEmoteToken(emote?.code);
    if (code) out.add(code);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export async function fetchBttvChannelEmotesForTwitchIds(
  twitchIds,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = 4
  } = {}
) {
  const results = new Map();
  const ids = [...new Set((twitchIds || []).map(String).filter(Boolean))];

  await mapLimit(ids, concurrency, async (id) => {
    const emotes = [];
    try {
      const data = await fetchJson(`https://api.betterttv.net/3/cached/users/twitch/${id}`, { timeoutMs });

      const channel = Array.isArray(data?.channelEmotes) ? data.channelEmotes : [];
      const shared = Array.isArray(data?.sharedEmotes) ? data.sharedEmotes : [];

      for (const emote of channel) {
        const code = normalizeEmoteToken(emote?.code);
        if (code) emotes.push(code);
      }

      for (const emote of shared) {
        const code = normalizeEmoteToken(emote?.code);
        if (code) emotes.push(code);
      }
    } catch (e) {
      console.error(`[BTTV] Failed to fetch channel emotes for Twitch ID ${id}:`, e.message);
    }
    results.set(id, emotes);
  });

  return results;
}



/* ────────────────────────────────────────────────────────────────
 * FFZ
 * ──────────────────────────────────────────────────────────────── */

export async function fetchFfzGlobalEmotes(
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const out = new Set();
  const global = await fetchJson('https://api.frankerfacez.com/v1/set/global', { timeoutMs });

  const defaultSets = Array.isArray(global?.default_sets) ? global.default_sets : [];
  const sets = global?.sets && typeof global.sets === 'object' ? global.sets : {};

  for (const setId of defaultSets) {
    const set = sets[String(setId)];
    const emoticons = Array.isArray(set?.emoticons) ? set.emoticons : [];
    for (const emote of emoticons) {
      const name = normalizeEmoteToken(emote?.name);
      if (name) out.add(name);
    }
  }

  return [...out].sort((a, b) => a.localeCompare(b));
}

export async function fetchFfzChannelEmotesForTwitchIds(
  twitchIds,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = 4
  } = {}
) {
  const results = new Map();
  const ids = [...new Set((twitchIds || []).map(String).filter(Boolean))];

  await mapLimit(ids, concurrency, async (id) => {
    const emotes = [];
    try {
      const data = await fetchJson(`https://api.frankerfacez.com/v1/room/id/${id}`, { timeoutMs });
      const sets = data?.sets && typeof data.sets === 'object' ? data.sets : {};

      for (const set of Object.values(sets)) {
        const emoticons = Array.isArray(set?.emoticons) ? set.emoticons : [];
        for (const emote of emoticons) {
          const name = normalizeEmoteToken(emote?.name);
          if (name) emotes.push(name);
        }
      }
    } catch (e) {
      console.error(`[FFZ] Failed to fetch channel emotes for Twitch ID ${id}:`, e.message);
    }
    results.set(id, emotes);
  });

  return results;
}

