import {
  createTaskEvent,
  emptyTaskRun,
  type TaskEvent,
  type TaskRun,
  type TaskSlackPostResult
} from "../shared/task";

export interface AppState {
  task: TaskRun | null;
  voiceStatus: "idle" | "connecting" | "ready" | "recording" | "listening" | "speaking" | "error";
  taskStatus: "idle" | "running" | "succeeded" | "failed";
  slackStatus: "idle" | "posting" | "posted" | "failed";
  prStatus: "idle" | "opening" | "opened" | "failed";
  prUrl: string | null;
  statusMessage: string;
}

export type AppAction =
  | { type: "set_voice_status"; status: AppState["voiceStatus"]; message?: string }
  | { type: "task_started"; task: TaskRun }
  | { type: "task_event"; event: TaskEvent }
  | { type: "task_finished"; task: TaskRun }
  | { type: "add_event"; event: TaskEvent }
  | { type: "slack_started" }
  | { type: "slack_finished"; result: TaskSlackPostResult }
  | { type: "pr_started" }
  | { type: "pr_finished"; ok: boolean; url: string | null; message: string }
  | { type: "sync_task"; task: TaskRun | null };

export const initialState: AppState = {
  task: null,
  voiceStatus: "idle",
  taskStatus: "idle",
  slackStatus: "idle",
  prStatus: "idle",
  prUrl: null,
  statusMessage: "Ready"
};

function ensureTask(state: AppState, fallbackText = "Idle"): TaskRun {
  return state.task ?? emptyTaskRun({ task: fallbackText });
}

export function taskReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "set_voice_status":
      return {
        ...state,
        voiceStatus: action.status,
        statusMessage: action.message ?? state.statusMessage
      };

    case "task_started":
      return {
        ...state,
        task: action.task,
        taskStatus: "running",
        prStatus: "idle",
        prUrl: null,
        statusMessage: `Codex working: ${action.task.task}`
      };

    case "task_event": {
      if (!state.task) return state;
      return {
        ...state,
        task: { ...state.task, timeline: [...state.task.timeline, action.event] }
      };
    }

    case "task_finished":
      return {
        ...state,
        task: action.task,
        taskStatus: action.task.status === "succeeded" ? "succeeded" : "failed",
        prUrl: action.task.pr_url ?? state.prUrl,
        statusMessage:
          action.task.status === "succeeded"
            ? action.task.summary ?? "Task complete"
            : action.task.summary ?? "Task failed"
      };

    case "add_event": {
      const task = ensureTask(state);
      return {
        ...state,
        task: { ...task, timeline: [...task.timeline, action.event] }
      };
    }

    case "slack_started":
      return { ...state, slackStatus: "posting", statusMessage: "Posting Slack update" };

    case "slack_finished": {
      const task = ensureTask(state);
      return {
        ...state,
        slackStatus: action.result.ok ? "posted" : "failed",
        statusMessage: action.result.ok ? "Slack update posted" : "Slack failed",
        task: {
          ...task,
          slack_thread_ts: action.result.thread_ts ?? task.slack_thread_ts ?? null,
          timeline: [
            ...task.timeline,
            createTaskEvent(
              action.result.ok ? "slack" : "error",
              "slack",
              action.result.ok
                ? `Posted Slack ${action.result.used_thread ? "thread reply" : "update"}.`
                : `Slack update failed: ${action.result.error}`,
              [action.result.message]
            )
          ]
        }
      };
    }

    case "pr_started":
      return { ...state, prStatus: "opening", statusMessage: "Opening pull request" };

    case "pr_finished": {
      const task = ensureTask(state);
      return {
        ...state,
        prStatus: action.ok ? "opened" : "failed",
        prUrl: action.url ?? state.prUrl,
        statusMessage: action.ok ? `PR opened: ${action.url ?? "see GitHub"}` : `PR failed: ${action.message}`,
        task: {
          ...task,
          pr_url: action.url ?? task.pr_url,
          timeline: [
            ...task.timeline,
            createTaskEvent(action.ok ? "result" : "error", "git", action.message, action.url ? [action.url] : undefined)
          ]
        }
      };
    }

    case "sync_task": {
      if (!action.task) return state;
      if (!state.task || action.task.timeline.length > state.task.timeline.length) {
        return { ...state, task: action.task };
      }
      return state;
    }
  }
}

export function currentTaskOrPlaceholder(state: AppState): TaskRun {
  return ensureTask(state, "No active task");
}
