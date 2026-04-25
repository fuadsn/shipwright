import { describe, expect, it } from "vitest";
import { initialState, taskReducer } from "../src/client/state";
import { createTaskEvent, emptyTaskRun } from "../src/shared/task";

describe("taskReducer", () => {
  it("starts a task and tracks running state", () => {
    const task = emptyTaskRun({
      task: "Find my todo app and add a dark mode toggle",
      now: new Date("2026-04-25T09:30:00.000Z")
    });

    const state = taskReducer(initialState, { type: "task_started", task });
    expect(state.task?.task).toContain("dark mode");
    expect(state.taskStatus).toBe("running");
    expect(state.task?.timeline[0].kind).toBe("input");
  });

  it("appends streaming step events under the active task", () => {
    const task = emptyTaskRun({ task: "Run the tests" });
    const started = taskReducer(initialState, { type: "task_started", task });
    const streamed = taskReducer(started, {
      type: "task_event",
      event: createTaskEvent("step", "codex", "Searching ~/Projects")
    });

    expect(streamed.task?.timeline.at(-1)?.content).toContain("Searching");
  });

  it("marks the task succeeded and stores PR url after completion", () => {
    const task = emptyTaskRun({ task: "Refactor X" });
    const started = taskReducer(initialState, { type: "task_started", task });
    const finished = taskReducer(started, {
      type: "task_finished",
      task: {
        ...task,
        status: "succeeded",
        finished_at: new Date().toISOString(),
        repo_path: "/tmp/repo",
        branch: "murphy/refactor-x",
        summary: "Refactored.",
        pr_url: "https://github.com/example/repo/pull/42"
      }
    });

    expect(finished.taskStatus).toBe("succeeded");
    expect(finished.prUrl).toBe("https://github.com/example/repo/pull/42");
  });
});
