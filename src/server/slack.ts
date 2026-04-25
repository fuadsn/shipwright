import type { IncidentLog, SlackPostResult } from "../shared/incident";
import type { SlackChannelReadResult, SlackConnectionStatus } from "../shared/slack";
import type { TaskRun, TaskSlackPostResult } from "../shared/task";
import type { SlackInstall } from "./types";

interface SlackOauthAccessResponse {
  ok?: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  team?: {
    id?: string;
    name?: string;
  };
  incoming_webhook?: {
    channel?: string;
    channel_id?: string;
  };
}

interface SlackConversation {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_member?: boolean;
}

interface SlackConversationsListResponse {
  ok?: boolean;
  error?: string;
  channels?: SlackConversation[];
}

interface SlackHistoryResponse {
  ok?: boolean;
  error?: string;
  messages?: Array<{
    type?: string;
    subtype?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  }>;
}

export function buildSlackMessage(incident: IncidentLog, override?: string): string {
  if (override?.trim()) {
    return override.trim();
  }

  const latestFinding = [...incident.timeline].reverse().find((event) => event.type === "finding");
  const status = incident.resolved_at ? "Resolved" : latestFinding ? "Mitigation identified" : "Investigating";

  return [
    `*${incident.header.severity} Incident - ${incident.header.service}*`,
    `*Status:* ${status}`,
    `*Symptom:* ${incident.header.symptom}`,
    `*Started:* ${new Date(incident.declared_at).toLocaleString()}`,
    `*Suspected trigger:* ${incident.header.suspected_trigger}`,
    latestFinding ? `*Latest finding:* ${latestFinding.content}` : "*Latest finding:* Under investigation"
  ].join("\n");
}

function slackRedirectUri() {
  return process.env.SLACK_REDIRECT_URI ?? "http://localhost:8787/api/slack/oauth/callback";
}

export function slackInstallUrl(): string | null {
  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    return null;
  }

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set(
    "scope",
    [
      "chat:write",
      "chat:write.public",
      "channels:read",
      "channels:join",
      "channels:history",
      "groups:read",
      "groups:history",
      "app_mentions:read"
    ].join(",")
  );
  url.searchParams.set("redirect_uri", slackRedirectUri());
  return url.toString();
}

export function slackConnectionStatus(install: SlackInstall | null): SlackConnectionStatus {
  if (install) {
    return {
      connected: true,
      mode: "oauth",
      team_name: install.team_name,
      channel_id: install.channel_id,
      channel_name: install.channel_name,
      channel_is_private: install.channel_is_private,
      channel_is_member: install.channel_is_member,
      bot_user_id: install.bot_user_id
    };
  }

  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID) {
    return {
      connected: true,
      mode: "env",
      channel_id: process.env.SLACK_CHANNEL_ID
    };
  }

  const missing_config = ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"].filter((key) => !process.env[key]);
  return {
    connected: false,
    mode: "none",
    install_url: slackInstallUrl() ?? undefined,
    redirect_uri: slackRedirectUri(),
    missing_config
  };
}

export async function listSlackChannels(install: SlackInstall | null) {
  const token = install?.bot_token ?? process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return [];
  }

  const response = await fetch(
    "https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200",
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );
  const data = (await response.json()) as SlackConversationsListResponse;
  if (!response.ok || !data.ok) {
    throw new Error(data.error ?? `Slack conversations.list failed with HTTP ${response.status}`);
  }

  return (data.channels ?? []).map((channel) => ({
    id: channel.id,
    name: channel.name ?? channel.id,
    is_member: Boolean(channel.is_member),
    is_private: Boolean(channel.is_private)
  }));
}

function issueLike(text: string): boolean {
  return /\b(incident|outage|down|failing|failed|error|errors|503|500|latency|spike|degraded|timeout|timeouts|p0|p1|p2|broken|issue|issues)\b/i.test(
    text
  );
}

function normalizeChannelName(name: string) {
  return name.trim().replace(/^#/, "").toLowerCase();
}

async function resolveSlackChannel(install: SlackInstall | null, query?: string) {
  const channels = await listSlackChannels(install);
  if (!query?.trim()) {
    return channels.find((channel) => channel.id === install?.channel_id) ?? channels[0];
  }

  const normalized = normalizeChannelName(query);
  return channels.find(
    (channel) => channel.id.toLowerCase() === normalized || normalizeChannelName(channel.name) === normalized
  );
}

export async function readSlackChannelHistory(
  install: SlackInstall | null,
  channelQuery?: string,
  limit = 15,
  mode: "last" | "issues" | "all" = "all"
): Promise<SlackChannelReadResult> {
  const token = install?.bot_token ?? process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return {
      ok: false,
      mode,
      scanned_count: 0,
      issue_count: 0,
      messages: [],
      summary: "Slack is not connected.",
      error: "Slack is not connected. Use Connect Slack first."
    };
  }

  const channel = await resolveSlackChannel(install, channelQuery);
  if (!channel) {
    return {
      ok: false,
      mode,
      scanned_count: 0,
      issue_count: 0,
      messages: [],
      summary: `I could not find ${channelQuery ? `#${normalizeChannelName(channelQuery)}` : "a Slack channel"} in the channels Murphy can see.`,
      error: "channel_not_found"
    };
  }

  let nextInstall = install;
  if (install && !channel.is_private && !channel.is_member) {
    nextInstall = await joinSlackChannelIfPossible({
      ...install,
      channel_id: channel.id,
      channel_name: channel.name,
      channel_is_private: false,
      channel_is_member: false
    });
  }

  const response = await fetch("https://slack.com/api/conversations.history", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${nextInstall?.bot_token ?? token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      channel: channel.id,
      limit: Math.min(Math.max(limit, 1), 15)
    })
  });
  const data = (await response.json()) as SlackHistoryResponse;

  if (!response.ok || !data.ok) {
    const error = data.error ?? `Slack HTTP ${response.status}`;
    const needsInvite = error === "not_in_channel" || error === "no_permission";
    return {
      ok: false,
      mode,
      channel_id: channel.id,
      channel_name: channel.name,
      scanned_count: 0,
      issue_count: 0,
      messages: [],
      summary: needsInvite
        ? `I can see #${channel.name}, but I cannot read its messages yet. Invite Murphy to the channel and reinstall with history scopes if needed.`
        : `I could not read #${channel.name}: ${error}.`,
      error
    };
  }

  const messages = (data.messages ?? [])
    .filter((message) => message.type === "message" && !message.subtype && !message.bot_id && message.text && message.ts)
    .map((message) => ({
      user: message.user,
      text: message.text!,
      ts: message.ts!,
      thread_ts: message.thread_ts
    }));
  const issueMessages = messages.filter((message) => issueLike(message.text));
  const returnedMessages = mode === "last" ? messages.slice(0, 1) : mode === "issues" ? issueMessages : messages;
  const summary =
    mode === "last"
      ? returnedMessages[0]
        ? `Latest message in #${channel.name}: ${returnedMessages[0].text}`
        : `I read #${channel.name}, but there were no recent human messages.`
      : mode === "issues"
        ? issueMessages.length > 0
          ? `I read #${channel.name} and found ${issueMessages.length} issue-like message${issueMessages.length === 1 ? "" : "s"} in the latest ${messages.length}.`
          : `I read #${channel.name}. I did not find issue-like messages in the latest ${messages.length}.`
        : `I read #${channel.name} and pulled the latest ${messages.length} human message${messages.length === 1 ? "" : "s"} for context.`;

  return {
    ok: true,
    mode,
    channel_id: channel.id,
    channel_name: channel.name,
    scanned_count: messages.length,
    issue_count: issueMessages.length,
    messages: returnedMessages,
    summary
  };
}

export async function exchangeSlackCode(code: string): Promise<SlackInstall> {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required for Slack OAuth.");
  }

  const body = new URLSearchParams({
    code,
    redirect_uri: slackRedirectUri()
  });
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const data = (await response.json()) as SlackOauthAccessResponse;

  if (!response.ok || !data.ok || !data.access_token || !data.team?.id) {
    throw new Error(data.error ?? `Slack OAuth failed with HTTP ${response.status}`);
  }

  return {
    team_id: data.team.id,
    team_name: data.team.name ?? data.team.id,
    bot_token: data.access_token,
    bot_user_id: data.bot_user_id,
    channel_id: data.incoming_webhook?.channel_id,
    channel_name: data.incoming_webhook?.channel,
    installed_at: new Date().toISOString()
  };
}

export async function joinSlackChannelIfPossible(install: SlackInstall): Promise<SlackInstall> {
  if (!install.channel_id || install.channel_is_private || install.channel_is_member) {
    return install;
  }

  const response = await fetch("https://slack.com/api/conversations.join", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${install.bot_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ channel: install.channel_id })
  });
  const data = (await response.json()) as {
    ok?: boolean;
    error?: string;
    warning?: string;
    channel?: { id?: string; name?: string; is_member?: boolean };
  };

  if (!response.ok || (!data.ok && data.error !== "already_in_channel")) {
    return install;
  }

  return {
    ...install,
    channel_name: data.channel?.name ?? install.channel_name,
    channel_is_member: true
  };
}

export function buildSlackTaskMessage(task: TaskRun, override?: string): string {
  if (override?.trim()) {
    return override.trim();
  }

  const status =
    task.status === "succeeded"
      ? "Done"
      : task.status === "failed"
        ? "Failed"
        : task.status === "cancelled"
          ? "Cancelled"
          : "Running";

  const lines = [
    `*Murphy task - ${status}*`,
    `*Ask:* ${task.task}`,
    task.repo_path ? `*Repo:* ${task.repo_path}` : null,
    task.branch ? `*Branch:* ${task.branch}` : null,
    task.pr_url ? `*PR:* ${task.pr_url}` : null,
    task.summary ? `*Summary:* ${task.summary}` : null,
    task.errors.length ? `*Errors:* ${task.errors.slice(0, 3).join("; ")}` : null
  ].filter(Boolean);
  return lines.join("\n");
}

export async function postSlackTaskUpdate(
  task: TaskRun,
  message?: string,
  existingThreadTs?: string | null,
  install?: SlackInstall | null
): Promise<TaskSlackPostResult> {
  const token = install?.bot_token ?? process.env.SLACK_BOT_TOKEN;
  const channel = install?.channel_id ?? process.env.SLACK_CHANNEL_ID;
  const text = buildSlackTaskMessage(task, message);

  if (!token || !channel) {
    return {
      ok: false,
      message: text,
      used_thread: Boolean(existingThreadTs),
      error: install
        ? "Slack is connected, but no posting channel is selected."
        : "Slack is not connected. Use Connect Slack or set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID."
    };
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      channel,
      text,
      mrkdwn: true,
      thread_ts: existingThreadTs ?? undefined
    })
  });

  const data = (await response.json()) as { ok?: boolean; ts?: string; error?: string };
  if (!response.ok || !data.ok || !data.ts) {
    return {
      ok: false,
      message: text,
      used_thread: Boolean(existingThreadTs),
      error: data.error ?? `Slack HTTP ${response.status}`
    };
  }

  return {
    ok: true,
    message: text,
    thread_ts: existingThreadTs ?? data.ts,
    used_thread: Boolean(existingThreadTs)
  };
}

export async function postSlackUpdate(
  incident: IncidentLog,
  message?: string,
  existingThreadTs?: string | null,
  install?: SlackInstall | null
): Promise<SlackPostResult> {
  const token = install?.bot_token ?? process.env.SLACK_BOT_TOKEN;
  const channel = install?.channel_id ?? process.env.SLACK_CHANNEL_ID;
  const text = buildSlackMessage(incident, message);

  if (!token || !channel) {
    return {
      ok: false,
      message: text,
      used_thread: Boolean(existingThreadTs),
      error: install
        ? "Slack is connected, but no posting channel is selected. Add Murphy to a channel or configure SLACK_CHANNEL_ID."
        : "Slack is not connected. Use Connect Slack or set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID."
    };
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      channel,
      text,
      mrkdwn: true,
      thread_ts: existingThreadTs ?? undefined
    })
  });

  const data = (await response.json()) as { ok?: boolean; ts?: string; error?: string };
  if (!response.ok || !data.ok || !data.ts) {
    return {
      ok: false,
      message: text,
      used_thread: Boolean(existingThreadTs),
      error: data.error ?? `Slack HTTP ${response.status}`
    };
  }

  return {
    ok: true,
    message: text,
    thread_ts: existingThreadTs ?? data.ts,
    used_thread: Boolean(existingThreadTs)
  };
}
