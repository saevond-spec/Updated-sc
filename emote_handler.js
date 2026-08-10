class EmoteHandler {
    constructor(emotesData = null) {
        this.emotePatterns = null;
        this.lastEmoteLoad = 0;
        this.emoteLoadCacheDuration = 60000;
        this.emotesData = emotesData;
    }

    setEmoteData(emotesData) {
        this.emotesData = emotesData;
        this.emotePatterns = null;
        this.lastEmoteLoad = 0;
    }

    loadEmotePatterns() {

        const currentTime = Date.now();
        if (this.emotePatterns && (currentTime - this.lastEmoteLoad) < this.emoteLoadCacheDuration) {
            return this.emotePatterns;
        }

        const allEmotes = new Set();

        try {
            if (this.emotesData) {
                if (Array.isArray(this.emotesData)) {
                    this.emotesData.forEach(emote => allEmotes.add(emote));
                } else if (typeof this.emotesData === 'object') {
                    Object.values(this.emotesData).forEach(emoteArray => {
                        if (Array.isArray(emoteArray)) {
                            emoteArray.forEach(emote => allEmotes.add(emote));
                        }
                    });
                }
            }
        } catch (error) {
            console.error('Error processing emotes data:', error);
        }

        const sortedEmotes = Array.from(allEmotes).sort((a, b) => b.length - a.length);

        if (sortedEmotes.length === 0) {
            this.emotePatterns = null;
            this.lastEmoteLoad = currentTime;
            console.log(`[EmoteHandler] Loaded 0 emotes for filtering`);
            return null;
        }

        const escapedEmotes = sortedEmotes.map(emote => emote.replace(/[.*+?^${}()|[\\]]/g, '\\$&'));

        this.emotePatterns = new RegExp(`(?<!\\S)(${escapedEmotes.join('|')})(?!\\S)`, 'g');
        this.lastEmoteLoad = currentTime;

        return this.emotePatterns;
    }

    /**
     * Extracts Twitch-native emote name strings from tmi.js tags
     * using the original (un-sliced) chat message for positional lookups.
     * @param {string} originalMessage - The full, un-sliced IRC message text
     * @param {object} tmiTags - The tmi.js tags object (or its .emotes sub-object)
     * @returns {Set<string>} Set of emote name strings found in the message
     */
    extractTwitchEmoteNames(originalMessage, tmiTags) {
        const names = new Set();
        if (!originalMessage || typeof originalMessage !== 'string') return names;

        const emotesObj =
            (tmiTags && typeof tmiTags === 'object' && tmiTags.emotes)
                ? tmiTags.emotes
                : (tmiTags && typeof tmiTags === 'object' && !Array.isArray(tmiTags) ? tmiTags : null);

        if (!emotesObj || typeof emotesObj !== 'object') return names;

        for (const ranges of Object.values(emotesObj)) {
            if (!Array.isArray(ranges)) continue;
            for (const raw of ranges) {
                if (typeof raw !== 'string') continue;
                const [s, e] = raw.split('-').map(n => Number.parseInt(n, 10));
                if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e < s) continue;
                if (e >= originalMessage.length) continue;
                const token = originalMessage.substring(s, e + 1).trim();
                if (token) names.add(token);
                // One range per emote ID is enough to capture the name; skip rest
                break;
            }
        }

        return names;
    }

    /**
     * Extracts Twitch-native emote IDs keyed by emote name, using the IRC `emotes` tag ranges.
     * This lets the dashboard render the real Twitch CDN images (by ID) without extra API calls.
     *
     * @param {string} originalMessage
     * @param {object} tmiTags
     * @returns {Object<string,string>} map of { [emoteName]: emoteId }
     */
    extractTwitchEmoteIdNameMap(originalMessage, tmiTags) {
        const out = {};
        if (!originalMessage || typeof originalMessage !== 'string') return out;

        const emotesObj =
            (tmiTags && typeof tmiTags === 'object' && tmiTags.emotes)
                ? tmiTags.emotes
                : null;

        if (!emotesObj || typeof emotesObj !== 'object') return out;

        for (const [emoteId, ranges] of Object.entries(emotesObj)) {
            if (!Array.isArray(ranges) || ranges.length === 0) continue;

            // Use first range to recover the emote name
            const raw = ranges[0];
            if (typeof raw !== 'string') continue;

            const [s, e] = raw.split('-').map(n => Number.parseInt(n, 10));
            if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e < s) continue;
            if (e >= originalMessage.length) continue;

            const name = originalMessage.substring(s, e + 1).trim();
            if (name) out[name] = String(emoteId);
        }

        return out;
    }

    /**
     * Flags Twitch-native emotes by name in any text (position-independent).
     * Safe to call on sliced/transformed text because it matches by token, not position.
     * @param {string} text - Any text (sliced, prepended, etc.)
     * @param {Set<string>} twitchEmoteNames - Emote names from extractTwitchEmoteNames()
     * @returns {string} Text with Twitch emotes prefixed as emote:NAME
     */
    flagTwitchEmotesInText(text, twitchEmoteNames) {
        if (!text || typeof text !== 'string') return text;
        if (!twitchEmoteNames || !(twitchEmoteNames instanceof Set) || twitchEmoteNames.size === 0) return text;

        const sorted = [...twitchEmoteNames].sort((a, b) => b.length - a.length);
        const escaped = sorted.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const pattern = new RegExp(`(?<!\\S)(${escaped.join('|')})(?!\\S)`, 'g');

        return text.replace(pattern, (match) => `emote:${match}`);
    }

    /**
     * Single entrypoint for "log-safe" chat text:
     *  1) Flag Twitch emotes (by name, extracted from original message positions)
     *  2) Flag 3P emotes from our loaded provider token sets (7TV/BTTV/FFZ)
     *
     * @param {string} text - Text to process (may be sliced/transformed)
     * @param {object} tmiTags - tmi.js tags object (contains .emotes)
     * @param {string} [originalMessage] - The full un-sliced IRC message (defaults to text)
     */
    processIncomingChatMessageForLogs(text, tmiTags = null, originalMessage = null) {
        if (!text || typeof text !== 'string') return text;

        let out = text;

        // Flag Twitch-native emotes (name-based extraction from original message)
        const srcMessage = originalMessage || text;
        const twitchEmoteNames = this.extractTwitchEmoteNames(srcMessage, tmiTags);
        out = this.flagTwitchEmotesInText(out, twitchEmoteNames);

        // Flag 3P emotes (7TV/BTTV/FFZ) via regex
        out = this.processEmotesForLogs(out);

        return out;
    }

    processEmotesForLogs(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }
        try {
            const emotePattern = this.loadEmotePatterns();
            if (!emotePattern) {
                return text;
            }
            return text.replace(emotePattern, (match) => `emote:${match}`);
        } catch (error) {
            console.error('[EmoteHandler] Error processing emotes:', error);
            return text;
        }
    }

    sanitizeResponse(responseText) {
        if (!responseText || typeof responseText !== 'string') {
            return responseText;
        }

        let sanitized = responseText.replace(/emote:/g, '');
        sanitized = sanitized.replace(/\s+/g, ' ');
        return sanitized.trim();
    }

    addEmoteSpacing(responseText) {
        if (!responseText || typeof responseText !== 'string') {
            return responseText;
        }

        const emotePattern = this.loadEmotePatterns();
        if (!emotePattern) {
            return responseText;
        }

        let processedText = responseText;

        const emoteMatches = [];
        let match;

        emotePattern.lastIndex = 0;

        while ((match = emotePattern.exec(responseText)) !== null) {
            emoteMatches.push({
                match: match[0],
                start: match.index,
                end: match.index + match[0].length
            });

            if (match.index === emotePattern.lastIndex) {
                emotePattern.lastIndex++;
            }
        }

        for (let i = emoteMatches.length - 1; i >= 0; i--) {
            const { match, start, end } = emoteMatches[i];

            const beforeText = responseText.substring(0, start);
            const afterText = responseText.substring(end);

            const needsPrefix = !/\s$/.test(beforeText) && beforeText.length > 0;
            const needsSuffix = !/^\s/.test(afterText) && afterText.length > 0;

            let spacing = '';
            if (needsPrefix) spacing += ' ';
            spacing += match;
            if (needsSuffix) spacing += ' ';

            processedText = beforeText + spacing + afterText;
        }

        return processedText;
    }

    processResponse(responseText, isImageCommand = false, emotesWereProcessed = false) {
        if (!responseText || typeof responseText !== 'string') {
            return responseText;
        }

        if (!emotesWereProcessed) {
            return responseText;
        }

        let processed = responseText;
        processed = this.sanitizeResponse(processed);
        processed = this.addEmoteSpacing(processed);

        return processed;
    }
}

export default EmoteHandler;