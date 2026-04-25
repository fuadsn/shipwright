# Murphy Incident Commander - Agent Handoff

## Current Product Shape

Murphy is a hackathon incident-response assistant with:

- React/Vite/Tailwind frontend at `src/client`
- Express/TypeScript backend at `src/server`
- OpenAI Realtime voice session with push-to-talk
- Codex CLI investigation wrapper over a seeded demo repo
- Slack OAuth connection, channel picker, Slack posting, Events API ingestion, and Slack channel history reads
- Local fallback paths for Codex/Slack failure

The app runs locally with:

```bash
npm run dev
```

Frontend: `http://localhost:5173`  
Backend: `http://localhost:8787`

## Important Files

- `src/client/App.tsx`: main UI, push-to-talk handling, Slack panel, Realtime tool handling
- `src/client/realtime.ts`: WebRTC Realtime connection, push-to-talk mic control, response interruption
- `src/client/state.ts`: incident reducer/state model
- `src/client/api.ts`: frontend API wrappers
- `src/server/index.ts`: Express routes, Realtime session config, Slack OAuth/events/tools
- `src/server/slack.ts`: Slack OAuth URL, channel listing, history reads, posting, auto-join
- `src/server/codexInvestigator.ts`: Codex CLI wrapper and JSON parser/fallback
- `src/server/demoWorkspace.ts`: seeded `payments-service` demo repo
- `src/server/slackStore.ts`: persists Slack install under `.demo/slack-install.json`
- `src/shared/incident.ts`: incident log/types
- `src/shared/slack.ts`: Slack status/history result types

## Environment

`.env` should contain:

```env
OPENAI_API_KEY=
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_SIGNING_SECRET=
SLACK_REDIRECT_URI=https://<public-url>/api/slack/oauth/callback
PORT=8787
CLIENT_ORIGIN=http://localhost:5173
CODEX_TIMEOUT_MS=75000
```

Optional dev fallback:

```env
SLACK_BOT_TOKEN=
SLACK_CHANNEL_ID=
```

Do not print or log secrets.

## Slack Setup

Slack app bot scopes currently expected:

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

OAuth redirect URL:

```text
https://<public-url>/api/slack/oauth/callback
```

Event Subscriptions request URL:

```text
https://<public-url>/api/slack/events
```

Bot events:

```text
message.channels
message.groups
app_mention
```

For local dev, use an HTTPS tunnel to backend port `8787`. Current ngrok URL may expire/change.

## Voice Behavior

Realtime voice is push-to-talk:

- Click **Start Voice**
- Hold Space to record
- Release Space to send
- Pressing Space while Murphy is speaking cancels the active Realtime response

`src/client/realtime.ts` controls mic track enable/disable. Automatic VAD is disabled via:

```ts
audio: {
  input: {
    turn_detection: null
  }
}
```

The browser `speechSynthesis` fallback only runs when Realtime voice is not active.

## Slack Behavior

Murphy can:

- Connect via OAuth
- List public/private channels it can see
- Save selected channel
- Auto-join public channels when possible
- Post parent updates and threaded replies
- Receive signed Slack Events
- Read recent Slack channel history on demand
- Persist OAuth install locally in `.demo/slack-install.json`

Slack channel read modes:

- `all`: default; reads recent human messages as shared context
- `last`: returns latest human message
- `issues`: filters for issue-like messages

Relevant backend endpoint:

```text
POST /api/tools/slack/read
```

Realtime tool:

```text
read_slack_channel
```

## Incident Flow

Main demo path:

1. Declare incident by voice or **Declare Demo**
2. Run **Investigate** or ask Murphy to investigate
3. Codex inspects seeded `.demo/payments-service`
4. Finding appended to live log
5. Slack update posts to selected channel/thread
6. Close incident generates postmortem draft

Seed demo repo:

```bash
npm run seed
```

## Current Capabilities

- Voice-first incident declaration
- Push-to-talk Realtime interaction
- Codex investigation wrapper with deterministic fallback
- Live incident timeline
- Slack OAuth/channel selection/posting/threading
- Slack Events API ingestion
- Slack channel history reads by voice/tool
- Postmortem draft generation/fallback

## Known Caveats

- Slack OAuth install is persisted locally, not database-backed.
- Events and OAuth require a public HTTPS URL.
- Slack private channels still require inviting Murphy.
- Slack history reads with bot tokens require channel access and history scopes.
- Slack `conversations.history` may be rate-limited depending on app/workspace status.
- Realtime tool behavior depends on current OpenAI Realtime API schema.
- Codex investigation is demo-oriented and runs against seeded local files.
- Incident extraction from arbitrary Slack text is heuristic.

## Verification

Use:

```bash
npm test
npm run build
```

Current test coverage:

- Incident reducer behavior
- Codex structured output parser
- Slack message builder/status
- Backend close endpoint smoke test

## Suggested Next Steps

1. Add tests for Slack signature verification and Slack Events URL challenge.
2. Add tests for `readSlackChannelHistory` with mocked Slack responses.
3. Improve UI by separating noisy system events from incident timeline.
4. Add a durable SQLite/file store for Slack installs and incidents.
5. Add explicit Slack “listening to #channel” status and last event timestamp.
6. Make Murphy’s Slack replies configurable: acknowledge all, only mentions, or only incident-like messages.
7. Add a production deploy target so OAuth no longer depends on ngrok.
