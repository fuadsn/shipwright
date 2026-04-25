import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexTask, type CodexEvent } from "./codexRunner";
import { createLogStreamFilter, type ParsedStep } from "./codexLogParser";
import { openPullRequest } from "./openPR";
import { buildProfiles, defaultProfileName, profilePromptHints, resolveProfile } from "./profile";
import {
  exchangeSlackCode,
  joinSlackChannelIfPossible,
  listSlackChannels,
  postSlackTaskUpdate,
  readSlackChannelHistory,
  slackConnectionStatus,
  slackInstallUrl
} from "./slack";
import { loadSlackInstall, saveSlackInstall } from "./slackStore";
import {
  createTaskEvent,
  emptyTaskRun,
  type SafetyMode,
  type TaskAllowedAction,
  type TaskEvent,
  type TaskRun
} from "../shared/task";
import type { ServerState, SlackTaskMessagePayload } from "./types";

export const app = express();
const port = Number(process.env.PORT ?? 8787);
const state: ServerState = {
  task: null,
  slackThreadTs: null,
  slackInstall: loadSlackInstall(),
  processedSlackEvents: new Set()
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173"
  })
);
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buffer) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    }
  })
);
app.use("/api/realtime/session", express.text({ type: ["application/sdp", "text/plain"] }));

interface SlackEventEnvelope {
  type: "url_verification" | "event_callback";
  token?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    channel?: string;
    text?: string;
    user?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
  };
}

function verifySlackSignature(req: express.Request): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return false;
  }

  const timestamp = req.header("x-slack-request-timestamp");
  const signature = req.header("x-slack-signature");
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
  if (!timestamp || !signature || !rawBody) {
    return false;
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  return expectedBuffer.length === signatureBuffer.length && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

function appendEvent(task: TaskRun, event: TaskEvent): TaskRun {
  return { ...task, timeline: [...task.timeline, event] };
}

function categoryToSource(category: ParsedStep["category"]): "codex" | "git" | "system" {
  if (category === "shell" || category === "file") return "git";
  if (category === "error") return "codex";
  return "codex";
}

function categoryToKind(category: ParsedStep["category"]): "step" | "error" {
  return category === "error" ? "error" : "step";
}

async function executeCodexTask(
  task: TaskRun,
  onEvent: (event: TaskEvent) => void
): Promise<TaskRun> {
  let working = task;
  const handleEvent = (event: TaskEvent) => {
    working = appendEvent(working, event);
    state.task = working;
    onEvent(event);
  };

  handleEvent(createTaskEvent("system", "system", `Profile: ${working.profile_label} (safety: ${working.safety_mode}).`));

  const logFilter = createLogStreamFilter();
  const onCodexEvent = (event: CodexEvent) => {
    if (event.type === "step") {
      const parsed = logFilter.ingest(event.line, event.structured);
      if (!parsed) return;
      handleEvent(
        createTaskEvent(
          categoryToKind(parsed.category),
          categoryToSource(parsed.category),
          parsed.content,
          parsed.evidence
        )
      );
    } else if (event.type === "error") {
      handleEvent(createTaskEvent("error", "codex", event.message));
    } else if (event.type === "result") {
      const r = event.result;
      working = {
        ...working,
        repo_path: r.repo_path,
        branch: r.branch,
        files_changed: r.files_changed,
        tests_run: r.tests_run,
        summary: r.summary,
        errors: r.errors
      };
      state.task = working;
      handleEvent(createTaskEvent("result", "codex", r.summary, [
        r.repo_path ? `repo=${r.repo_path}` : "repo=unknown",
        r.branch ? `branch=${r.branch}` : "branch=none",
        `files_changed=${r.files_changed.length}`,
        `tests_run=${r.tests_run.length}`
      ]));
    }
  };

  try {
    const outcome = await runCodexTask({
      task: working.task,
      profile: working.profile,
      search_roots: working.search_roots,
      allowed_actions: working.allowed_actions,
      safety_mode: working.safety_mode,
      onEvent: onCodexEvent
    });

    for (const tail of logFilter.flush()) {
      handleEvent(
        createTaskEvent(
          categoryToKind(tail.category),
          categoryToSource(tail.category),
          tail.content,
          tail.evidence
        )
      );
    }

    const finishedAt = new Date().toISOString();
    if (outcome.result) {
      working = {
        ...working,
        status: outcome.result.status,
        finished_at: finishedAt
      };
    } else {
      working = {
        ...working,
        status: outcome.exitCode === 0 ? "succeeded" : "failed",
        finished_at: finishedAt,
        summary: working.summary ?? (outcome.exitCode === 0
          ? "Codex finished, but no structured summary was produced."
          : "Codex did not complete successfully."),
        errors: outcome.exitCode === 0 ? working.errors : [...working.errors, `Codex exited with code ${outcome.exitCode}`]
      };
    }
    state.task = working;
    return working;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    handleEvent(createTaskEvent("error", "system", `Codex runner failed: ${message}`));
    working = {
      ...working,
      status: "failed",
      finished_at: new Date().toISOString(),
      errors: [...working.errors, message],
      summary: working.summary ?? "Codex runner failed before completing the task."
    };
    state.task = working;
    return working;
  }
}

function isLikelyChatter(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6) return true;
  return /^(hi|hey|hello|gm|good morning|thanks|thx|ty|lol|haha|nice|cool|ok|okay|yes|no|sure|same|wfh|brb)\b\s*[!.?]?$/i.test(
    trimmed
  );
}

function detectsPRIntent(text: string): boolean {
  if (/\b(open|create|raise|submit|make|push|file)\b[^.]*\b(pr|pull request)\b/i.test(text)) return true;
  if (/\b(pr|pull request)\b[^.]*\b(please|it|now|too|also)\b/i.test(text)) return true;
  if (/\bopen a pr\b|\bship a pr\b|\braise a pr\b/i.test(text)) return true;
  return false;
}

async function handleSlackMessage(envelope: SlackEventEnvelope) {
  const event = envelope.event;
  if (!event?.channel || !event.text || !event.ts) {
    return;
  }
  if (event.subtype || event.bot_id || event.user === state.slackInstall?.bot_user_id) {
    return;
  }
  if (state.slackInstall?.channel_id && event.channel !== state.slackInstall.channel_id) {
    return;
  }

  const threadTs = event.thread_ts ?? event.ts;
  state.slackThreadTs = threadTs;

  // Quick chatter filter — don't react to "thanks" / "ok" etc.
  if (isLikelyChatter(event.text)) {
    return;
  }

  const profile = resolveProfile();
  const task = emptyTaskRun({
    task: event.text,
    profile: profile.name,
    profile_label: profile.label,
    search_roots: profile.search_roots,
    allowed_actions: profile.allowed_actions,
    safety_mode: profile.safety_mode
  });
  task.slack_thread_ts = threadTs;
  state.task = {
    ...task,
    timeline: [
      ...task.timeline,
      createTaskEvent("slack", "slack", `New issue from Slack: ${event.text}`)
    ]
  };

  // Proactive acknowledgment — post within seconds so the channel sees Murphy is alive.
  await postSlackTaskUpdate(
    state.task,
    `:eyes: Murphy is on it. Investigating "${event.text.slice(0, 140)}${event.text.length > 140 ? "…" : ""}" under the *${profile.label}* profile. I'll reply with findings in this thread.`,
    threadTs,
    state.slackInstall
  );

  const finished = await executeCodexTask(state.task, () => undefined);
  state.task = finished;

  const reply = finished.status === "succeeded"
    ? `:white_check_mark: ${finished.summary ?? "Done."}${finished.repo_path ? `\n*Repo:* \`${finished.repo_path}\`` : ""}${finished.branch ? `\n*Branch:* \`${finished.branch}\`` : ""}${finished.files_changed.length ? `\n*Files:* ${finished.files_changed.slice(0, 6).join(", ")}` : ""}`
    : `:x: ${finished.summary ?? "Task failed."}${finished.errors.length ? `\n${finished.errors.slice(0, 2).join("\n")}` : ""}`;
  await postSlackTaskUpdate(finished, reply, threadTs, state.slackInstall);

  // Auto-PR if the user asked for one in the original Slack message.
  const wantsPR = detectsPRIntent(event.text);
  const prEligible =
    wantsPR &&
    finished.status === "succeeded" &&
    Boolean(finished.repo_path) &&
    Boolean(finished.branch) &&
    finished.safety_mode !== "read_only";

  if (wantsPR && finished.safety_mode === "read_only") {
    await postSlackTaskUpdate(
      finished,
      `:lock: This task ran under *${finished.profile_label}* (read-only). I won't open a PR. Re-run on staging if you want a PR.`,
      threadTs,
      state.slackInstall
    );
    return;
  }

  if (!prEligible) return;

  await postSlackTaskUpdate(
    finished,
    ":outbox_tray: Pushing branch and opening PR…",
    threadTs,
    state.slackInstall
  );

  const prResult = await openPullRequest({
    repo_path: finished.repo_path!,
    branch: finished.branch!,
    push: true
  });

  state.task = appendEvent(
    finished,
    createTaskEvent(
      prResult.ok ? "result" : "error",
      "git",
      prResult.message,
      [
        prResult.repo_path ? `repo=${prResult.repo_path}` : "repo=unknown",
        prResult.branch ? `branch=${prResult.branch}` : "branch=none",
        prResult.pr_url ? `pr=${prResult.pr_url}` : "pr=none"
      ]
    )
  );
  if (prResult.ok) {
    state.task = { ...state.task, pr_url: prResult.pr_url };
  }

  await postSlackTaskUpdate(
    state.task,
    prResult.ok && prResult.pr_url
      ? `:rocket: PR opened: ${prResult.pr_url}`
      : `:warning: ${prResult.message}`,
    threadTs,
    state.slackInstall
  );
}

function sessionConfig() {
  return {
    type: "realtime",
    model: "gpt-realtime",
    instructions: [
      "Always speak and respond in English, regardless of the language of the user's audio input. Never switch to another language unless the user explicitly asks you to.",
      "You are Murphy, a calm voice/Slack-first remote operator for an autonomous engineer (Codex).",
      "Your personality is a pragmatic engineering partner: observant, dryly funny when there is room, and impossible to rattle.",
      "Usability always wins. Never let personality make responses longer, less clear, or less actionable.",
      ...profilePromptHints(buildProfiles(), defaultProfileName()),
      "Keep spoken responses concise and ordered by what the operator should know or do next.",
      "Workflow:",
      "1. When the user describes a task in natural language, call run_codex_task with the task text.",
      "   - Default search_roots is [\"~/Projects\"] unless the user names a different folder.",
      "   - Default allowed_actions is [\"read\",\"edit\",\"test\",\"git\"]; safety_mode defaults to edit_local (no remote push).",
      "2. While Codex is working, briefly narrate progress only when the user asks. Avoid blow-by-blow.",
      "3. When Codex finishes, report: which repo, which branch, what changed, whether tests ran, and any errors.",
      "4. If the user explicitly says to open a PR or push, call open_pr.",
      "5. Use write_slack_message to post task progress to Slack on request.",
      "6. Use read_slack_channel to read incoming asks from Slack.",
      "Never push or open a PR unless the user explicitly asks for it."
    ].join("\n"),
    audio: {
      input: {
        turn_detection: null
      },
      output: {
        voice: "marin"
      }
    },
    tools: [
      {
        type: "function",
        name: "run_codex_task",
        description:
          "Hand a natural-language engineering task to Codex. Codex searches the chosen profile's roots, finds the right repo, makes edits on a new branch (when allowed), and reports back. Does not push or open a PR.",
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "The natural-language task to perform, exactly as the user described it."
            },
            profile: {
              type: "string",
              enum: ["prod", "staging", "free"],
              description:
                "Which access profile to use. 'prod' is read-only and locked to MURPHY_PROD_PATH. 'staging' is read-write and locked to MURPHY_STAGING_PATH. 'free' is the default for unspecified work."
            },
            search_roots: {
              type: "array",
              items: { type: "string" },
              description: "Optional override for filesystem roots. Only set if the user names a folder Codex should look in."
            },
            allowed_actions: {
              type: "array",
              items: { type: "string", enum: ["read", "edit", "test", "git", "github_pr"] },
              description: "Optional override of capabilities. Usually leave unset and let the profile decide."
            },
            safety_mode: {
              type: "string",
              enum: ["read_only", "edit_local", "auto_pr"],
              description: "Optional override of safety posture. Usually leave unset and let the profile decide."
            }
          },
          required: ["task"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "open_pr",
        description:
          "Push the working branch from the most recent run_codex_task and open a GitHub PR via gh. Only call when the user explicitly asks. Refuses if the active task ran under the prod (read-only) profile.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            base: { type: "string", description: "Base branch, defaults to repo default." }
          },
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "write_slack_message",
        description: "Post a task update to Slack, threading follow-up updates.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string" }
          },
          required: ["message"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "read_slack_channel",
        description: "Read recent messages from a Slack channel by name or ID.",
        parameters: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Slack channel name or ID, for example tasks or C123." },
            limit: { type: "number", description: "Number of recent messages to inspect, up to 15." },
            mode: {
              type: "string",
              enum: ["last", "issues", "all"],
              description:
                "Use all by default. Use last when the user asks for the latest message. Use issues when explicitly scanning for problem reports."
            }
          },
          required: ["channel"],
          additionalProperties: false
        }
      }
    ]
  };
}

app.post("/api/realtime/session", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    res.status(400).json({ error: "OPENAI_API_KEY is required for live Realtime voice." });
    return;
  }

  try {
    const form = new FormData();
    form.set("sdp", req.body);
    form.set("session", JSON.stringify(sessionConfig()));

    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: form
    });

    const text = await response.text();
    if (!response.ok) {
      res.status(response.status).send(text);
      return;
    }

    res.type("application/sdp").send(text);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

interface RunTaskBody {
  task?: string;
  profile?: string;
  search_roots?: string[];
  allowed_actions?: TaskAllowedAction[];
  safety_mode?: SafetyMode;
}

app.post("/api/tools/codex/run", async (req, res) => {
  const body = req.body as RunTaskBody;
  if (!body.task?.trim()) {
    res.status(400).json({ error: "task is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const sendSse = (event: string, payload: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const profile = resolveProfile(body.profile);
  const task = emptyTaskRun({
    task: body.task.trim(),
    profile: profile.name,
    profile_label: profile.label,
    search_roots: body.search_roots ?? profile.search_roots,
    allowed_actions: body.allowed_actions ?? profile.allowed_actions,
    safety_mode: body.safety_mode ?? profile.safety_mode
  });
  state.task = task;
  sendSse("task", task);

  const finished = await executeCodexTask(task, (event) => sendSse("event", event));
  sendSse("done", finished);
  res.end();
});

app.get("/api/profile", (_req, res) => {
  const profiles = buildProfiles();
  const defaultName = defaultProfileName();
  res.json({
    default: defaultName,
    profiles: Object.values(profiles).map((profile) => ({
      name: profile.name,
      label: profile.label,
      safety_mode: profile.safety_mode,
      allowed_actions: profile.allowed_actions,
      search_roots: profile.search_roots,
      description: profile.description,
      enforce: profile.enforce
    }))
  });
});

app.get("/api/tools/codex/current", (_req, res) => {
  res.json({ task: state.task });
});

app.post("/api/tools/codex/open-pr", async (req, res) => {
  const body = req.body as { title?: string; body?: string; base?: string };
  if (state.task && state.task.safety_mode === "read_only") {
    res.status(403).json({
      ok: false,
      error: "read_only_profile",
      message: `Last task ran under ${state.task.profile_label}. Re-run that work under the staging profile before opening a PR.`,
      pr_url: null,
      branch: state.task.branch,
      repo_path: state.task.repo_path
    });
    return;
  }
  if (!state.task || !state.task.repo_path) {
    res.status(400).json({ error: "no_active_task", message: "Run a task first so I have a repo and branch." });
    return;
  }

  const result = await openPullRequest({
    repo_path: state.task.repo_path,
    branch: state.task.branch,
    title: body.title,
    body: body.body,
    base: body.base,
    push: true
  });

  state.task = appendEvent(state.task, createTaskEvent(
    result.ok ? "result" : "error",
    "git",
    result.message,
    [
      result.repo_path ? `repo=${result.repo_path}` : "repo=unknown",
      result.branch ? `branch=${result.branch}` : "branch=none",
      result.pr_url ? `pr=${result.pr_url}` : "pr=none"
    ]
  ));
  if (result.ok) {
    state.task = { ...state.task, pr_url: result.pr_url };
  }
  res.json(result);
});

app.post("/api/tools/slack", async (req, res) => {
  const { task, message } = req.body as SlackTaskMessagePayload;
  if (!task) {
    res.status(400).json({ error: "task is required" });
    return;
  }

  state.task = task;
  const result = await postSlackTaskUpdate(task, message, state.slackThreadTs, state.slackInstall);
  if (result.thread_ts) {
    state.slackThreadTs = result.thread_ts;
  }
  res.json(result);
});

app.post("/api/tools/slack/read", async (req, res) => {
  const { channel, limit, mode } = req.body as { channel?: string; limit?: number; mode?: "last" | "issues" | "all" };
  try {
    const result = await readSlackChannelHistory(state.slackInstall, channel, limit, mode);
    if (state.task) {
      state.task = appendEvent(
        state.task,
        createTaskEvent(
          result.ok ? "slack" : "error",
          "slack",
          result.summary,
          result.messages.map((message) => message.text)
        )
      );
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/slack/status", (_req, res) => {
  res.json(slackConnectionStatus(state.slackInstall));
});

app.get("/api/slack/install", (_req, res) => {
  const url = slackInstallUrl();
  if (!url) {
    res.status(400).send("SLACK_CLIENT_ID is required to start Slack OAuth.");
    return;
  }
  res.redirect(url);
});

app.get("/api/slack/oauth/callback", async (req, res) => {
  const error = typeof req.query.error === "string" ? req.query.error : null;
  const code = typeof req.query.code === "string" ? req.query.code : null;

  if (error) {
    res.redirect(`${process.env.CLIENT_ORIGIN ?? "http://localhost:5173"}/?slack=denied&error=${encodeURIComponent(error)}`);
    return;
  }

  if (!code) {
    res.redirect(`${process.env.CLIENT_ORIGIN ?? "http://localhost:5173"}/?slack=missing_code`);
    return;
  }

  try {
    state.slackInstall = await exchangeSlackCode(code);
    saveSlackInstall(state.slackInstall);
    state.slackThreadTs = null;
    res.redirect(`${process.env.CLIENT_ORIGIN ?? "http://localhost:5173"}/?slack=connected`);
  } catch (oauthError) {
    const message = oauthError instanceof Error ? oauthError.message : String(oauthError);
    res.redirect(`${process.env.CLIENT_ORIGIN ?? "http://localhost:5173"}/?slack=failed&error=${encodeURIComponent(message)}`);
  }
});

app.get("/api/slack/channels", async (_req, res) => {
  try {
    res.json({ channels: await listSlackChannels(state.slackInstall) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/slack/channel", (req, res) => {
  const { channel_id, channel_name, channel_is_private, channel_is_member } = req.body as {
    channel_id?: string;
    channel_name?: string;
    channel_is_private?: boolean;
    channel_is_member?: boolean;
  };
  if (!channel_id?.trim()) {
    res.status(400).json({ error: "channel_id is required" });
    return;
  }

  const save = async () => {
    if (!state.slackInstall) {
      if (process.env.SLACK_BOT_TOKEN) {
        process.env.SLACK_CHANNEL_ID = channel_id.trim();
      }
      state.slackThreadTs = null;
      res.json(slackConnectionStatus(state.slackInstall));
      return;
    }

    state.slackInstall = {
      ...state.slackInstall,
      channel_id: channel_id.trim(),
      channel_name: channel_name?.trim() || channel_id.trim(),
      channel_is_private: Boolean(channel_is_private),
      channel_is_member: Boolean(channel_is_member)
    };
    state.slackInstall = await joinSlackChannelIfPossible(state.slackInstall);
    saveSlackInstall(state.slackInstall);

    state.slackThreadTs = null;
    res.json(slackConnectionStatus(state.slackInstall));
  };

  void save().catch((error) => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });
});

app.post("/api/slack/events", (req, res) => {
  if (!verifySlackSignature(req)) {
    res.status(401).json({ error: "invalid Slack signature" });
    return;
  }

  const envelope = req.body as SlackEventEnvelope;
  if (envelope.type === "url_verification" && envelope.challenge) {
    res.json({ challenge: envelope.challenge });
    return;
  }

  if (envelope.event_id && state.processedSlackEvents.has(envelope.event_id)) {
    res.json({ ok: true, duplicate: true });
    return;
  }
  if (envelope.event_id) {
    state.processedSlackEvents.add(envelope.event_id);
  }

  res.json({ ok: true });

  if (envelope.type === "event_callback" && ["message", "app_mention"].includes(envelope.event?.type ?? "")) {
    void handleSlackMessage(envelope).catch((error) => {
      console.error("Slack event processing failed", error);
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    realtime: Boolean(process.env.OPENAI_API_KEY),
    slack: slackConnectionStatus(state.slackInstall).connected,
    codex_timeout_ms: Number(process.env.CODEX_TIMEOUT_MS ?? 600_000)
  });
});

const distPath = path.resolve(__dirname, "../../dist");
app.use(express.static(distPath));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`Murphy Codex remote API running on http://localhost:${port}`);
  });
}
