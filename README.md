# Murphy Incident Commander

Voice-first incident response demo for the OpenAI Codex Hackathon.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5173`.

Required for the live path:

- `OPENAI_API_KEY`
- Slack OAuth app credentials: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI`
- Codex CLI available as `codex`

The demo still works without Codex or Slack credentials. Investigation falls back to deterministic seeded findings, and Slack failures are written into the incident log instead of blocking the flow.

For quick local development, `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` are still supported as a fallback. For real users, use the in-app **Connect Slack** button with a Slack app that has the `chat:write` bot scope. After OAuth, pick the channel in the Murphy UI so incident updates can be posted as a parent message with threaded replies.

## Slack OAuth Setup

1. Go to [Slack API apps](https://api.slack.com/apps) and create or open the Murphy app.
2. Open **Basic Information**. Copy **Client ID** into `SLACK_CLIENT_ID` and **Client Secret** into `SLACK_CLIENT_SECRET`.
3. Open **OAuth & Permissions** and add your HTTPS redirect URL. For local dev, expose the API server with ngrok or Cloudflare Tunnel and use:

```text
https://your-public-dev-url.example.com/api/slack/oauth/callback
```

4. In **OAuth & Permissions**, add these bot token scopes:

```text
chat:write
chat:write.public
channels:read
channels:join
channels:history
groups:read
groups:history
app_mentions:read
```

`chat:write` lets Murphy post incident updates. `chat:write.public` and `channels:join` reduce setup friction for public channels by letting Murphy post or join without a manual invite. `channels:read` and `groups:read` let Murphy show public and private channels in the picker. `channels:history`, `groups:history`, and `app_mentions:read` let Murphy read selected incident-channel messages and mentions.

Private channels still require inviting Murphy from Slack.
5. In **Event Subscriptions**, enable events and set the request URL:

```text
https://your-public-dev-url.example.com/api/slack/events
```

Subscribe to bot events:

```text
message.channels
message.groups
app_mention
```

Murphy can also read a channel on demand from voice. By default, “read the issues channel” pulls recent human messages as context. “Look for issues in the issues channel” filters for issue-like messages. This uses Slack `conversations.history`, which requires `channels:history` for public channels and `groups:history` for private channels. With bot tokens, Slack only returns history for conversations the bot can access.

6. Restart `npm run dev`, then use **Connect Slack** inside Murphy.

## Useful Commands

```bash
npm run seed
npm test
npm run build
```
