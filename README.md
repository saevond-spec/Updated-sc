# SweatyClanker v3

DeepSeek-only Twitch AI bot with IRC, EventSub, moderation, memory, and low-usage automation workers.

## Worker system

Eight logical task types share one physical BullMQ queue and one worker connection to reduce Redis usage:

- analyze-vod
- generate-clips
- create-thumbnail
- stream-summary
- post-social
- discord-announce
- moderation-review
- memory-cleanup

Submit a job with POST /api/jobs/:type and the x-worker-key header. Configure WORKER_API_KEY first. Example:

    curl -X POST https://YOUR-SERVICE.onrender.com/api/jobs/analyze-vod \
      -H "content-type: application/json" \
      -H "x-worker-key: YOUR_WORKER_API_KEY" \
      -d '{"vodId":"123","channel":"saevond","title":"Ranked Naraka","transcript":"..."}'

The analysis worker uses DeepSeek and chains clip generation and stream summary jobs. Clip creation, thumbnail rendering, and social publishing require their corresponding webhook URLs. Discord uses a standard Discord webhook URL.

## Automatic Twitch VOD highlights

The optional highlight detector watches live chat reactions and Twitch EventSub follow notifications while a tracked Twitch channel is online. A follow strengthens nearby chat evidence; it is not treated as proof of a gameplay highlight by itself. It uses lightweight reaction-spike rules to decide when an AI review is worthwhile, then asks DeepSeek to conservatively score the evidence. It stores only the strongest timestamps in Redis. After the stream ends and Twitch exposes the archive VOD, it sends up to five moments by default (configurable up to eight) to Amaana. Amaana assembles a longer highlight video, cuts Shorts from the assembly, and uploads the highlight and Shorts as private YouTube drafts. Each Twitch source clip is at most 60 seconds. Continuous 24/7 streams must actually end before this post-stream workflow starts. Follow signals require a working Twitch `channel.follow` EventSub subscription with `moderator:read:followers` authorization.

This is AI-assisted **chat-reaction detection**. DeepSeek is text-only and does not watch the video or hear the audio. Streams with no qualifying chat reactions do not produce a highlight batch.

Required Render variables:

- `CLIP_WEBHOOK_URL=https://amaana-yt.onrender.com/api/twitch/vod-clips`
- `CLIP_WEBHOOK_KEY`: the same secret as Amaana's `AGENT_KEY`
- `HIGHLIGHT_DETECTION_ENABLED=true`

Optional tuning variables are `HIGHLIGHT_WINDOW_SECONDS`, `HIGHLIGHT_MIN_MESSAGES`, `HIGHLIGHT_COOLDOWN_SECONDS`, and `HIGHLIGHT_MAX_CLIPS`. Do not commit the webhook key.

Worker results are written to worker-output as JSON. Render's filesystem is ephemeral, so configure the posting integrations or move results to durable storage for long-term retention.

## Redis budget

REDIS_MONTHLY_COMMAND_LIMIT defaults to 300000 and REDIS_SAFETY_RESERVE defaults to 15000. Nonessential writes stop at an estimated 285000 commands. GET /api/redis-budget reports the current process estimate. BullMQ was consolidated from eight queues to one to greatly reduce idle Redis traffic.

## Deploy

Set the required Twitch, DeepSeek, Redis, OAuth, and worker variables shown in .env.example or render.yaml, then run:

    npm install
    npm start
