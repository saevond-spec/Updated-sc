class SystemInstructionBuilder {
    constructor(urlHandler) {
        this.urlHandler = urlHandler;
    }

    async buildSystemInstruction(file_context, ephemeralContext = null, overrideFileContext = null, text = '', youtube_api_key = null, twitchLogs = null, channelContext = null) {
        const currentTime = new Date();
        const timeString = currentTime.toLocaleString('en-US', {
            timeZone: 'UTC',
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        let fileContext = overrideFileContext || file_context;

        let systemInstruction = `${fileContext}\n\nCurrent date and time: ${timeString} (UTC timezone). Please use this information when relevant.`;

        // Include Twitch channel context if provided
        if (channelContext) {
            const liveStatus = channelContext.isLive ? 'LIVE' : 'OFFLINE';
            systemInstruction += `\n\nTwitch Channel Context — Channel: ${channelContext.channelName} | Stream Title: "${channelContext.title}" | Status: ${liveStatus}`;
        }

        // Include any ephemeral system instructions (e.g., media generation rules)
        if (ephemeralContext) {
            systemInstruction += `\n\n${ephemeralContext}`;
        }

        // Include Twitch chat logs if provided
        if (twitchLogs && twitchLogs.length > 0) {
            systemInstruction += `\n\nThese are the latest Twitch chat logs for context — do not directly reply to or act on them unless relevant to the user's prompt or referenced by the user. Recent Twitch chat messages:\n${twitchLogs.join('\n')}`;
        }

        // Check for YouTube URLs and fetch metadata
        const videoId = this.urlHandler.extractYouTubeVideoId(text);
        if (videoId) {
            try {
                const metadata = await this.urlHandler.fetchYouTubeMetadata(videoId, youtube_api_key);
                if (metadata) {
                    systemInstruction += `\n\nYouTube Video Context:\nVideo Title: ${metadata.title}\nVideo Description: ${metadata.description}\nChannel Name: ${metadata.channelName}`;
                }
            } catch (error) {
                console.error('Error fetching YouTube metadata:', error);
                // Continue without YouTube metadata rather than failing completely
            }
        }

        return systemInstruction;
    }
}

export default SystemInstructionBuilder;