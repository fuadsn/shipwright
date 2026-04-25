import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { SafetyMode, TaskAllowedAction, TaskResult } from "../shared/task";
import { codexPromptHints, resolveProfile } from "./profile";

const MURPHY_RESULT_TAG = "MURPHY_RESULT:";

const taskResultSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  repo_path: z.string().nullable(),
  branch: z.string().nullable(),
  files_changed: z.array(z.string()),
  tests_run: z.array(z.string()),
  summary: z.string(),
  errors: z.array(z.string())
});

export type CodexEvent =
  | { type: "step"; line: string; structured?: Record<string, unknown> }
  | { type: "result"; result: TaskResult }
  | { type: "error"; message: string }
  | { type: "done"; code: number; durationMs: number };

export interface RunCodexTaskOptions {
  task: string;
  profile?: string;
  search_roots?: string[];
  allowed_actions?: TaskAllowedAction[];
  safety_mode?: SafetyMode;
  timeoutMs?: number;
  cwd?: string;
  onEvent?: (event: CodexEvent) => void;
}

export interface RunCodexTaskOutcome {
  exitCode: number;
  durationMs: number;
  result: TaskResult | null;
  rawOutput: string;
  events: CodexEvent[];
}

export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export function buildCodexPrompt(opts: RunCodexTaskOptions & { profile?: string }): string {
  const profile = resolveProfile(opts.profile);
  const searchRoots = (opts.search_roots ?? profile.search_roots).map(expandHome);
  const actions = opts.allowed_actions ?? profile.allowed_actions;
  const safety = opts.safety_mode ?? profile.safety_mode;

  const safetyHints = codexPromptHints(profile, safety);

  const lines = [
    "You are Murphy's autonomous engineer. Take the user's natural-language task and complete it end to end.",
    "",
    `User task: ${opts.task}`,
    "",
    `Active profile: ${profile.label} - ${profile.description}`,
    ...(safetyHints.length ? ["", ...safetyHints] : []),
    "",
    "Working approach:",
    "1. Search the listed roots to identify the most relevant repository for this task.",
    "2. Read enough code to understand the change needed. Do not edit unrelated areas.",
    safety === "read_only"
      ? "3. DO NOT edit. Only inspect. Produce a report describing what would need to change."
      : "3. If editing is allowed, make the smallest correct change that satisfies the task.",
    "4. If a test command is obvious from the repo (npm test, pytest, go test, cargo test), run it and capture output (read-only profile: skip this).",
    safety === "read_only"
      ? "5. DO NOT run git commit, git checkout -b, or any mutating shell command."
      : "5. If git is allowed, create a fresh branch named murphy/<short-slug> and commit your changes there.",
    "6. Do NOT push to a remote, and do NOT open a pull request. The operator triggers that as a separate step.",
    "",
    `Search roots (try these first, recurse as needed): ${searchRoots.join(", ")}`,
    `Allowed actions: ${actions.join(", ")}`,
    `Safety mode: ${safety}`,
    "",
    "When you are completely done, the LAST line of your output MUST be a single line that begins with",
    `${MURPHY_RESULT_TAG} followed by a JSON object on the same line with these keys:`,
    `{"status": "succeeded" | "failed", "repo_path": string|null, "branch": string|null,`,
    ` "files_changed": string[], "tests_run": string[], "summary": string, "errors": string[]}`,
    "",
    "Notes:",
    "- repo_path is the absolute path of the repo you actually worked in.",
    "- branch is the branch name you committed on (or null if no git changes).",
    "- summary is one short paragraph for a non-engineer.",
    "- If you could not complete the task, set status to failed and put the reason in errors.",
    "- Do not include any text after the MURPHY_RESULT line."
  ];
  return lines.join("\n");
}

function parseStructuredLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function extractTaskResult(rawOutput: string): TaskResult | null {
  const lines = rawOutput.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const idx = line.indexOf(MURPHY_RESULT_TAG);
    if (idx === -1) continue;
    const jsonText = line.slice(idx + MURPHY_RESULT_TAG.length).trim();
    try {
      const parsed = taskResultSchema.parse(JSON.parse(jsonText));
      return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveCwd(opts: RunCodexTaskOptions): string {
  if (opts.cwd && existsSync(opts.cwd)) return opts.cwd;
  for (const root of opts.search_roots ?? ["~/Projects"]) {
    const expanded = expandHome(root);
    if (existsSync(expanded)) return expanded;
  }
  return homedir();
}

export async function runCodexTask(opts: RunCodexTaskOptions): Promise<RunCodexTaskOutcome> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS ?? 600_000);
  const cwd = resolveCwd(opts);
  const prompt = buildCodexPrompt(opts);

  const args = (process.env.CODEX_EXEC_ARGS?.trim() || "exec --dangerously-bypass-approvals-and-sandbox")
    .split(/\s+/)
    .filter(Boolean);
  args.push(prompt);

  const events: CodexEvent[] = [];
  const emit = (event: CodexEvent) => {
    events.push(event);
    opts.onEvent?.(event);
  };

  const startedAt = Date.now();
  let rawOutput = "";

  return await new Promise<RunCodexTaskOutcome>((resolve) => {
    const child = spawn("codex", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let buffer = "";
    const flushLines = (chunk: string, isFinal = false) => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = isFinal ? "" : parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        rawOutput += line + "\n";
        const structured = parseStructuredLine(line);
        emit({ type: "step", line, structured });
      }
      if (isFinal && buffer) {
        rawOutput += buffer;
        emit({ type: "step", line: buffer });
        buffer = "";
      }
    };

    const timer = setTimeout(() => {
      emit({ type: "error", message: `Codex task timed out after ${timeoutMs}ms` });
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => flushLines(chunk.toString()));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      rawOutput += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) emit({ type: "step", line: `[stderr] ${line}` });
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", message });
      const durationMs = Date.now() - startedAt;
      emit({ type: "done", code: -1, durationMs });
      resolve({ exitCode: -1, durationMs, result: null, rawOutput, events });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      flushLines("", true);
      const result = extractTaskResult(rawOutput);
      if (result) emit({ type: "result", result });
      const durationMs = Date.now() - startedAt;
      emit({ type: "done", code: code ?? 0, durationMs });
      resolve({ exitCode: code ?? 0, durationMs, result, rawOutput, events });
    });
  });
}
