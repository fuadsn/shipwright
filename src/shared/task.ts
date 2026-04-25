export type TaskStatus = "idle" | "running" | "succeeded" | "failed" | "cancelled";

export type SafetyMode = "read_only" | "edit_local" | "auto_pr";

export type TaskAllowedAction = "read" | "edit" | "test" | "git" | "github_pr";

export type TaskEventKind = "input" | "step" | "result" | "system" | "slack" | "error";

export type TaskEventSource = "user" | "codex" | "system" | "slack" | "git" | "voice";

export interface TaskEvent {
  id: string;
  timestamp: string;
  kind: TaskEventKind;
  source: TaskEventSource;
  content: string;
  evidence?: string[];
}

export interface TaskResult {
  status: "succeeded" | "failed";
  repo_path: string | null;
  branch: string | null;
  files_changed: string[];
  tests_run: string[];
  summary: string;
  errors: string[];
}

export interface TaskRun {
  id: string;
  task: string;
  profile: string;
  profile_label: string;
  search_roots: string[];
  allowed_actions: TaskAllowedAction[];
  safety_mode: SafetyMode;
  started_at: string;
  finished_at: string | null;
  status: TaskStatus;
  repo_path: string | null;
  branch: string | null;
  files_changed: string[];
  tests_run: string[];
  pr_url: string | null;
  summary: string | null;
  errors: string[];
  timeline: TaskEvent[];
  slack_thread_ts: string | null;
}

export interface OpenPRResult {
  ok: boolean;
  pr_url: string | null;
  branch: string | null;
  repo_path: string | null;
  error: string | null;
  message: string;
}

export interface TaskSlackPostResult {
  ok: boolean;
  message: string;
  thread_ts?: string;
  used_thread: boolean;
  error?: string;
}

export const defaultSearchRoots = ["~/Projects"];

export const defaultAllowedActions: TaskAllowedAction[] = ["read", "edit", "test", "git"];

export function createTaskId(now = new Date()): string {
  const compact = now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replaceAll("T", "")
    .replaceAll("Z", "")
    .slice(0, 14);
  return `task-${compact}`;
}

export function createTaskEvent(
  kind: TaskEventKind,
  source: TaskEventSource,
  content: string,
  evidence?: string[],
  now = new Date()
): TaskEvent {
  return {
    id: `${kind}-${source}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: now.toISOString(),
    kind,
    source,
    content,
    evidence
  };
}

export function emptyTaskRun(input: {
  task: string;
  profile?: string;
  profile_label?: string;
  search_roots?: string[];
  allowed_actions?: TaskAllowedAction[];
  safety_mode?: SafetyMode;
  now?: Date;
}): TaskRun {
  const now = input.now ?? new Date();
  return {
    id: createTaskId(now),
    task: input.task,
    profile: input.profile ?? "free",
    profile_label: input.profile_label ?? "free",
    search_roots: input.search_roots?.length ? input.search_roots : defaultSearchRoots,
    allowed_actions: input.allowed_actions?.length ? input.allowed_actions : defaultAllowedActions,
    safety_mode: input.safety_mode ?? "edit_local",
    started_at: now.toISOString(),
    finished_at: null,
    status: "running",
    repo_path: null,
    branch: null,
    files_changed: [],
    tests_run: [],
    pr_url: null,
    summary: null,
    errors: [],
    timeline: [createTaskEvent("input", "user", input.task, undefined, now)],
    slack_thread_ts: null
  };
}
