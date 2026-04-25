import type {
  OpenPRResult,
  SafetyMode,
  TaskAllowedAction,
  TaskEvent,
  TaskRun,
  TaskSlackPostResult
} from "../shared/task";
import type { SlackChannelReadResult, SlackConnectionStatus } from "../shared/slack";

export interface SlackChannel {
  id: string;
  name: string;
  is_member: boolean;
  is_private: boolean;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export interface RunCodexTaskInput {
  task: string;
  profile?: "prod" | "staging" | "free";
  search_roots?: string[];
  allowed_actions?: TaskAllowedAction[];
  safety_mode?: SafetyMode;
}

export interface RunCodexTaskHandlers {
  onStart: (task: TaskRun) => void;
  onEvent: (event: TaskEvent) => void;
  onDone: (task: TaskRun) => void;
}

export async function runCodexTask(input: RunCodexTaskInput, handlers: RunCodexTaskHandlers): Promise<void> {
  const response = await fetch("/api/tools/codex/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `runCodexTask failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (eventName: string, data: string) => {
    const trimmed = data.trim();
    if (!trimmed) return;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (eventName === "task") handlers.onStart(payload as TaskRun);
    else if (eventName === "event") handlers.onEvent(payload as TaskEvent);
    else if (eventName === "done") handlers.onDone(payload as TaskRun);
  };

  const flushBlock = (block: string) => {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    dispatch(eventName, dataLines.join("\n"));
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      flushBlock(block);
    }
  }
  if (buffer.trim()) flushBlock(buffer);
}

export async function openPullRequest(input: { title?: string; body?: string; base?: string }): Promise<OpenPRResult> {
  return postJson<OpenPRResult>("/api/tools/codex/open-pr", input);
}

export async function postSlack(task: TaskRun, message?: string): Promise<TaskSlackPostResult> {
  return postJson<TaskSlackPostResult>("/api/tools/slack", { task, message });
}

export async function readSlackChannel(
  channel: string,
  limit = 15,
  mode: "last" | "issues" | "all" = "all"
): Promise<SlackChannelReadResult> {
  return postJson<SlackChannelReadResult>("/api/tools/slack/read", { channel, limit, mode });
}

export async function getSlackStatus(): Promise<SlackConnectionStatus> {
  const response = await fetch("/api/slack/status");
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as SlackConnectionStatus;
}

export async function getSlackChannels(): Promise<SlackChannel[]> {
  const response = await fetch("/api/slack/channels");
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = (await response.json()) as { channels: SlackChannel[] };
  return data.channels;
}

export async function setSlackChannel(channel: {
  channel_id: string;
  channel_name?: string;
  channel_is_private?: boolean;
  channel_is_member?: boolean;
}): Promise<SlackConnectionStatus> {
  return postJson<SlackConnectionStatus>("/api/slack/channel", channel);
}

export async function getCurrentTask(): Promise<TaskRun | null> {
  const response = await fetch("/api/tools/codex/current");
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const data = (await response.json()) as { task: TaskRun | null };
  return data.task;
}

export interface MurphyProfileInfo {
  name: "prod" | "staging" | "free";
  label: string;
  safety_mode: SafetyMode;
  allowed_actions: TaskAllowedAction[];
  search_roots: string[];
  description: string;
  enforce: "advisory" | "strict";
}

export interface MurphyProfileResponse {
  default: "prod" | "staging" | "free";
  profiles: MurphyProfileInfo[];
}

export async function getProfile(): Promise<MurphyProfileResponse> {
  const response = await fetch("/api/profile");
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as MurphyProfileResponse;
}
