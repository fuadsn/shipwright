import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock,
  Eye,
  GitBranch,
  GitPullRequest,
  Hash,
  Lock,
  LockOpen,
  Mic,
  RefreshCw,
  Send,
  Square,
  Terminal,
  Wifi,
  WifiOff
} from "lucide-react";
import {
  getCurrentTask,
  getProfile,
  getSlackChannels,
  getSlackStatus,
  openPullRequest,
  postSlack,
  readSlackChannel,
  runCodexTask,
  setSlackChannel,
  type MurphyProfileInfo,
  type SlackChannel
} from "./api";
import { connectRealtime, type RealtimeConnection } from "./realtime";
import { currentTaskOrPlaceholder, initialState, taskReducer } from "./state";
import { createTaskEvent, type TaskEvent } from "../shared/task";
import type { SlackConnectionStatus } from "../shared/slack";

function formatTime(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}

function StatusPill({
  tone,
  children
}: {
  tone: "green" | "amber" | "blue" | "red" | "muted";
  children: React.ReactNode;
}) {
  const tones = {
    green: "border-command-green/40 bg-command-green/10 text-command-green",
    amber: "border-command-amber/50 bg-command-amber/10 text-command-amber",
    blue: "border-command-blue/50 bg-command-blue/10 text-command-blue",
    red: "border-command-red/50 bg-command-red/10 text-command-red",
    muted: "border-command-line bg-command-rail text-command-muted"
  };

  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Waveform({ active }: { active: boolean }) {
  return (
    <div className="flex h-8 items-center gap-1" aria-hidden="true">
      {Array.from({ length: 18 }).map((_, index) => (
        <motion.span
          key={index}
          className="w-1 rounded bg-command-blue"
          animate={{ height: active ? [8, 28 - (index % 5) * 3, 10] : 8, opacity: active ? 1 : 0.35 }}
          transition={{ repeat: active ? Infinity : 0, duration: 0.9, delay: index * 0.035 }}
        />
      ))}
    </div>
  );
}

function EventRow({ event }: { event: TaskEvent }) {
  const sourceStyle = {
    user: "border-l-command-blue",
    voice: "border-l-command-blue",
    codex: "border-l-command-amber",
    git: "border-l-command-green",
    system: "border-l-command-muted",
    slack: "border-l-command-green"
  }[event.source];

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className={`border-l-2 ${sourceStyle} bg-command-panel px-4 py-3`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-command-muted">
        <span>{formatTime(event.timestamp)}</span>
        <span className="uppercase tracking-wide">{event.source}</span>
        <span>{event.kind}</span>
      </div>
      <p className="text-sm leading-6 text-command-text">{event.content}</p>
      {event.evidence?.length ? (
        <ul className="mt-2 space-y-1 text-xs leading-5 text-command-muted">
          {event.evidence.map((item, idx) => (
            <li key={`${item}-${idx}`}>{item}</li>
          ))}
        </ul>
      ) : null}
    </motion.article>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-12 w-full items-center justify-center gap-2 rounded border border-command-line bg-command-panel px-3 text-sm font-medium text-command-text transition hover:border-command-blue disabled:cursor-not-allowed disabled:opacity-45"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 border-b border-command-line/60 py-1.5 last:border-b-0">
      <span className="text-[11px] uppercase text-command-muted">{label}</span>
      <span className="max-w-[150px] break-words text-right text-xs text-command-text">{value}</span>
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(taskReducer, initialState);
  const stateRef = useRef(state);
  const connectionRef = useRef<RealtimeConnection | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [slackConnection, setSlackConnection] = useState<SlackConnectionStatus | null>(null);
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([]);
  const [slackChannelInput, setSlackChannelInput] = useState("");
  const [slackChannelSearch, setSlackChannelSearch] = useState("");
  const [slackConfigMessage, setSlackConfigMessage] = useState<string | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [taskInput, setTaskInput] = useState("");
  const [profiles, setProfiles] = useState<MurphyProfileInfo[]>([]);
  const [defaultProfile, setDefaultProfile] = useState<"prod" | "staging" | "free">("free");
  const [selectedProfile, setSelectedProfile] = useState<"prod" | "staging" | "free" | "auto">("auto");

  useEffect(() => {
    stateRef.current = state;
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state]);

  const refreshSlack = async () => {
    try {
      const status = await getSlackStatus();
      setSlackConnection(status);
      setSlackChannelInput(status.channel_id ?? "");
      if (status.connected) {
        const channels = await getSlackChannels().catch(() => []);
        setSlackChannels(channels);
      }
    } catch (error) {
      setSlackConfigMessage(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void refreshSlack();
    void getProfile()
      .then((response) => {
        setProfiles(response.profiles);
        setDefaultProfile(response.default);
      })
      .catch(() => undefined);
    const url = new URL(window.location.href);
    const slack = url.searchParams.get("slack");
    if (slack === "connected") {
      setSlackConfigMessage("Slack connected. Pick the channel Murphy should post to.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (slack === "failed" || slack === "denied") {
      setSlackConfigMessage(url.searchParams.get("error") ?? "Slack connection was not completed.");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const task = await getCurrentTask();
        dispatch({ type: "sync_task", task });
      } catch {
        // best effort
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, []);

  const filteredSlackChannels = useMemo(() => {
    const query = slackChannelSearch.trim().toLowerCase();
    return slackChannels
      .filter((channel) => !query || channel.name.toLowerCase().includes(query) || channel.id.toLowerCase().includes(query))
      .sort((a, b) => {
        if (a.id === slackConnection?.channel_id) return -1;
        if (b.id === slackConnection?.channel_id) return 1;
        if (a.is_member !== b.is_member) return a.is_member ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [slackChannelSearch, slackChannels, slackConnection?.channel_id]);

  const selectedSlackChannel = useMemo(
    () => slackChannels.find((channel) => channel.id === slackChannelInput),
    [slackChannelInput, slackChannels]
  );

  const speak = (text: string) => {
    const liveVoiceActive =
      stateRef.current.voiceStatus === "connecting" ||
      stateRef.current.voiceStatus === "ready" ||
      stateRef.current.voiceStatus === "recording" ||
      stateRef.current.voiceStatus === "listening" ||
      stateRef.current.voiceStatus === "speaking";

    if (liveVoiceActive) {
      return;
    }

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    }
  };

  const runTask = async (
    task: string,
    options?: { search_roots?: string[]; profile?: "prod" | "staging" | "free" }
  ) => {
    if (!task.trim()) return;
    const profile = options?.profile ?? (selectedProfile === "auto" ? undefined : selectedProfile);
    await runCodexTask(
      { task: task.trim(), search_roots: options?.search_roots, profile },
      {
        onStart: (started) => dispatch({ type: "task_started", task: started }),
        onEvent: (event) => dispatch({ type: "task_event", event }),
        onDone: (finished) => {
          dispatch({ type: "task_finished", task: finished });
          if (finished.summary) speak(finished.summary);
        }
      }
    );
  };

  const sendSlack = async (message?: string) => {
    const task = currentTaskOrPlaceholder(stateRef.current);
    dispatch({ type: "slack_started" });
    const result = await postSlack(task, message);
    dispatch({ type: "slack_finished", result });
    return result;
  };

  const triggerOpenPR = async (title?: string, body?: string) => {
    dispatch({ type: "pr_started" });
    try {
      const result = await openPullRequest({ title, body });
      dispatch({
        type: "pr_finished",
        ok: result.ok,
        url: result.pr_url,
        message: result.message
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "pr_finished", ok: false, url: null, message });
      throw error;
    }
  };

  const saveSlackChannel = async () => {
    const selected = slackChannels.find((channel) => channel.id === slackChannelInput);
    const status = await setSlackChannel({
      channel_id: slackChannelInput,
      channel_name: selected?.name,
      channel_is_private: selected?.is_private,
      channel_is_member: selected?.is_member
    });
    setSlackConnection(status);
    if (selected?.is_private && !status.channel_is_member) {
      setSlackConfigMessage(`Slack channel set to #${selected.name}. Invite Murphy before posting to this private channel.`);
    } else {
      setSlackConfigMessage(`Slack channel set to ${selected?.name ? `#${selected.name}` : slackChannelInput}.`);
    }
    dispatch({
      type: "add_event",
      event: createTaskEvent(
        "system",
        "slack",
        `Slack channel selected: ${status.channel_name ? `#${status.channel_name}` : status.channel_id}.`
      )
    });
  };

  const connectVoice = async () => {
    try {
      setVoiceError(null);
      const connection = await connectRealtime({
        getTask: () => stateRef.current.task,
        onStatus: (status, message) => dispatch({ type: "set_voice_status", status, message }),
        onActivity: (message) => {
          dispatch({ type: "add_event", event: createTaskEvent("system", "system", message) });
        },
        onTranscript: (text) => {
          dispatch({ type: "add_event", event: createTaskEvent("input", "voice", text) });
        },
        onToolCall: async (name, args) => {
          if (name === "run_codex_task") {
            const task = typeof args.task === "string" ? args.task : "";
            const searchRoots = Array.isArray(args.search_roots)
              ? (args.search_roots.filter((root): root is string => typeof root === "string"))
              : undefined;
            const profile = args.profile === "prod" || args.profile === "staging" || args.profile === "free"
              ? args.profile
              : undefined;
            await runTask(task, { search_roots: searchRoots, profile });
            return stateRef.current.task ?? { ok: true };
          }
          if (name === "open_pr") {
            const title = typeof args.title === "string" ? args.title : undefined;
            const body = typeof args.body === "string" ? args.body : undefined;
            return await triggerOpenPR(title, body);
          }
          if (name === "write_slack_message") {
            return await sendSlack(typeof args.message === "string" ? args.message : undefined);
          }
          if (name === "read_slack_channel") {
            const channel = typeof args.channel === "string" ? args.channel : "tasks";
            const limit = typeof args.limit === "number" ? args.limit : 15;
            const mode = args.mode === "last" ? "last" : args.mode === "issues" ? "issues" : "all";
            const result = await readSlackChannel(channel, limit, mode);
            dispatch({
              type: "add_event",
              event: createTaskEvent(
                result.ok ? "slack" : "error",
                "slack",
                result.summary,
                result.messages.map((message) => message.text)
              )
            });
            return result;
          }
          throw new Error(`Unknown Realtime tool: ${name}`);
        }
      });
      connectionRef.current = connection;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVoiceError(message);
      dispatch({ type: "set_voice_status", status: "error", message: "Voice unavailable" });
    }
  };

  const disconnectVoice = () => {
    connectionRef.current?.disconnect();
    connectionRef.current = null;
    setSpaceHeld(false);
    dispatch({ type: "set_voice_status", status: "idle", message: "Voice disconnected" });
  };

  // Auto-connect voice on mount so push-to-talk is ready without an extra click.
  // If the browser has not yet granted mic permission, this will prompt; if denied,
  // the error surfaces and the manual Start Voice button remains as a fallback.
  useEffect(() => {
    if (connectionRef.current) return;
    void connectVoice();
    return () => {
      connectionRef.current?.disconnect();
      connectionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const task = state.task;
  const voiceActive = state.voiceStatus === "recording" || state.voiceStatus === "speaking";
  const taskRunning = state.taskStatus === "running";
  const activeProfile = useMemo(
    () => profiles.find((p) => p.name === (selectedProfile === "auto" ? defaultProfile : selectedProfile)) ?? null,
    [profiles, selectedProfile, defaultProfile]
  );
  const taskProfileIsReadOnly = task?.safety_mode === "read_only";
  const canOpenPR = !taskProfileIsReadOnly && task?.status === "succeeded" && Boolean(task.repo_path) && Boolean(task.branch);

  useEffect(() => {
    const editableSelector = "input, textarea, select, [contenteditable='true']";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || !connectionRef.current) {
        return;
      }
      if (event.target instanceof Element && event.target.closest(editableSelector)) {
        return;
      }
      event.preventDefault();
      setSpaceHeld(true);
      connectionRef.current.startPushToTalk();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !connectionRef.current) {
        return;
      }
      if (event.target instanceof Element && event.target.closest(editableSelector)) {
        return;
      }
      event.preventDefault();
      setSpaceHeld(false);
      connectionRef.current.stopPushToTalk();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  return (
    <main className="flex h-screen flex-col bg-command-bg text-command-text">
      <header className="shrink-0 border-b border-command-line bg-command-panel px-5 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-11 w-11 items-center justify-center rounded bg-command-rail">
              <Bot className="h-6 w-6 text-command-amber" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Murphy</h1>
              <p className="text-sm text-command-muted">From a Slack thread to a pull request / {state.statusMessage}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {task ? (
              <StatusPill
                tone={
                  task.safety_mode === "read_only"
                    ? "red"
                    : task.profile === "staging"
                      ? "amber"
                      : "muted"
                }
              >
                {task.safety_mode === "read_only" ? <Lock className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                {task.profile_label}
              </StatusPill>
            ) : null}
            <StatusPill tone={state.voiceStatus === "error" ? "red" : voiceActive ? "green" : "muted"}>
              {voiceActive ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {state.voiceStatus}
            </StatusPill>
            <StatusPill
              tone={
                state.taskStatus === "failed"
                  ? "red"
                  : state.taskStatus === "running"
                    ? "blue"
                    : state.taskStatus === "succeeded"
                      ? "green"
                      : "muted"
              }
            >
              <Terminal className="h-3.5 w-3.5" />
              {state.taskStatus}
            </StatusPill>
            <StatusPill
              tone={
                state.prStatus === "failed"
                  ? "red"
                  : state.prStatus === "opened"
                    ? "green"
                    : state.prStatus === "opening"
                      ? "blue"
                      : "muted"
              }
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              {state.prStatus === "opened" && state.prUrl ? "PR opened" : state.prStatus}
            </StatusPill>
            <StatusPill tone={state.slackStatus === "failed" ? "red" : state.slackStatus === "posted" ? "green" : "muted"}>
              <Send className="h-3.5 w-3.5" />
              {slackConnection?.connected ? "slack connected" : state.slackStatus}
            </StatusPill>
          </div>
        </div>
      </header>

      <section className="shrink-0 border-b border-command-line px-5 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <Waveform active={voiceActive} />
            <div className="text-sm text-command-muted">
              {state.voiceStatus === "ready" || state.voiceStatus === "recording" || state.voiceStatus === "speaking" ? (
                <span>{spaceHeld ? "Recording. Release Space to send." : "Hold Space to talk to Murphy."}</span>
              ) : task ? (
                <span>{task.task}</span>
              ) : (
                <span>No active task. Say or type something for Codex to do.</span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={connectVoice}
              className="inline-flex min-h-10 items-center gap-2 rounded border border-command-line bg-command-panel px-3 text-sm hover:border-command-blue"
            >
              <Mic className="h-4 w-4" />
              Start Voice
            </button>
            <button
              type="button"
              onClick={disconnectVoice}
              className="inline-flex min-h-10 items-center gap-2 rounded border border-command-line bg-command-panel px-3 text-sm hover:border-command-red"
            >
              <Square className="h-4 w-4" />
              Stop
            </button>
          </div>
        </div>
        {voiceError ? <p className="mt-2 text-xs text-command-red">{voiceError}</p> : null}
      </section>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[1fr_300px]">
        <section className="flex min-h-0 flex-col overflow-hidden">
          <div className="shrink-0 border-b border-command-line px-5 py-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 className="text-lg font-semibold">{task?.task ?? "Awaiting task"}</h2>
                <p className="mt-1 text-sm text-command-muted">
                  {task
                    ? `${task.repo_path ?? "Searching for repo..."}${task.branch ? ` / ${task.branch}` : ""}${
                        task.pr_url ? ` / PR: ${task.pr_url}` : ""
                      }`
                    : "Drop a task in here, or post one in your connected Slack channel. Murphy turns it into a branch, then into a PR when you say so."}
                </p>
              </div>
              {task ? (
                <div className="flex items-center gap-2 text-sm text-command-muted">
                  <Clock className="h-4 w-4" />
                  {formatTime(task.started_at)}
                </div>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-command-muted">Profile:</span>
              {(["auto", "prod", "staging", "free"] as const).map((option) => {
                const profileMeta = option === "auto"
                  ? { label: `auto (${defaultProfile})`, hint: "Let Murphy pick" }
                  : profiles.find((p) => p.name === option)
                    ? { label: profiles.find((p) => p.name === option)!.label, hint: profiles.find((p) => p.name === option)!.description }
                    : { label: option, hint: option };
                const selected = selectedProfile === option;
                return (
                  <button
                    key={option}
                    type="button"
                    title={profileMeta.hint}
                    onClick={() => setSelectedProfile(option)}
                    className={`rounded border px-2 py-1 transition ${
                      selected
                        ? option === "prod"
                          ? "border-command-red bg-command-red/10 text-command-red"
                          : option === "staging"
                            ? "border-command-amber bg-command-amber/10 text-command-amber"
                            : "border-command-blue bg-command-blue/10 text-command-text"
                        : "border-command-line bg-command-panel text-command-muted hover:border-command-blue"
                    }`}
                  >
                    {profileMeta.label}
                  </button>
                );
              })}
              {activeProfile ? (
                <span className="ml-auto text-[10px] text-command-muted">
                  Roots: {activeProfile.search_roots.join(", ")}
                </span>
              ) : null}
            </div>
            <form
              className="mt-2 flex flex-col gap-2 md:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (!taskInput.trim() || taskRunning) return;
                const value = taskInput;
                setTaskInput("");
                void runTask(value);
              }}
            >
              <input
                value={taskInput}
                onChange={(event) => setTaskInput(event.target.value)}
                disabled={taskRunning}
                placeholder='e.g. "Look in ~/Projects, find my todo app, and add a dark mode toggle"'
                className="min-h-10 flex-1 rounded border border-command-line bg-command-panel px-3 text-sm text-command-text placeholder:text-command-muted disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!taskInput.trim() || taskRunning}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded border border-command-line bg-command-panel px-4 text-sm font-medium hover:border-command-blue disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Bot className="h-4 w-4 text-command-amber" />
                {taskRunning ? "Running" : "Send to Codex"}
              </button>
            </form>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="space-y-3">
              <AnimatePresence initial={false}>
                {task?.timeline.map((event) => <EventRow key={event.id} event={event} />)}
              </AnimatePresence>
              <div ref={logEndRef} />
            </div>
          </div>

          {task && task.status !== "running" && task.status !== "idle" ? (
            <section className="border-t border-command-line bg-command-bg px-5 py-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-command-text">
                <CheckCircle2 className={`h-4 w-4 ${task.status === "succeeded" ? "text-command-green" : "text-command-red"}`} />
                Task Result
              </div>
              <div className="grid gap-4 text-sm leading-6 text-command-muted lg:grid-cols-2">
                <div>
                  <h3 className="mb-1 text-xs uppercase text-command-text">Summary</h3>
                  <p>{task.summary ?? "No summary."}</p>
                </div>
                <div>
                  <h3 className="mb-1 text-xs uppercase text-command-text">Repo / Branch</h3>
                  <p className="break-all">{task.repo_path ?? "n/a"}</p>
                  <p className="text-xs">{task.branch ?? "no branch"}</p>
                </div>
                <div>
                  <h3 className="mb-1 text-xs uppercase text-command-text">Files changed</h3>
                  <ul className="space-y-1 text-xs">
                    {task.files_changed.length
                      ? task.files_changed.map((file) => <li key={file}>{file}</li>)
                      : <li>None</li>}
                  </ul>
                </div>
                <div>
                  <h3 className="mb-1 text-xs uppercase text-command-text">Tests run</h3>
                  <ul className="space-y-1 text-xs">
                    {task.tests_run.length
                      ? task.tests_run.map((test) => <li key={test}>{test}</li>)
                      : <li>None</li>}
                  </ul>
                </div>
                {task.errors.length ? (
                  <div className="lg:col-span-2">
                    <h3 className="mb-1 text-xs uppercase text-command-red">Errors</h3>
                    <ul className="space-y-1 text-xs text-command-red">
                      {task.errors.map((error, idx) => <li key={`${error}-${idx}`}>{error}</li>)}
                    </ul>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </section>

        <aside className="overflow-y-auto border-t border-command-line bg-command-rail p-4 lg:border-l lg:border-t-0">
          <section className="mb-4 border-b border-command-line pb-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Hash className="h-4 w-4 text-command-green" />
                Slack
              </div>
              <button
                type="button"
                onClick={() => void refreshSlack()}
                className="inline-flex h-8 w-8 items-center justify-center rounded border border-command-line bg-command-panel hover:border-command-blue"
                title="Refresh Slack"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>

            {slackConnection?.connected ? (
              <div className="space-y-3">
                <div className="rounded border border-command-line bg-command-panel px-3 py-2">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-command-text">
                    <Eye className="h-3.5 w-3.5 text-command-blue" />
                    Slack Visibility
                  </div>
                  <DetailRow label="Workspace" value={slackConnection.team_name ?? "Connected"} />
                  <DetailRow
                    label="Channel"
                    value={
                      slackConnection.channel_name
                        ? `#${slackConnection.channel_name}`
                        : slackConnection.channel_id
                          ? slackConnection.channel_id
                          : "Not selected"
                    }
                  />
                  <DetailRow
                    label="Type"
                    value={
                      slackConnection.channel_id
                        ? slackConnection.channel_is_private
                          ? "Private"
                          : "Public"
                        : "Pending"
                    }
                  />
                  <DetailRow
                    label="Access"
                    value={
                      slackConnection.channel_id
                        ? slackConnection.channel_is_private && !slackConnection.channel_is_member
                          ? "Invite needed"
                          : "Can post"
                        : "Choose channel"
                    }
                  />
                  <DetailRow label="Visible" value={`${slackChannels.length} channels`} />
                </div>
                {slackChannels.length ? (
                  <div className="space-y-2">
                    <input
                      value={slackChannelSearch}
                      onChange={(event) => setSlackChannelSearch(event.target.value)}
                      placeholder="Search channels"
                      className="min-h-10 w-full rounded border border-command-line bg-command-panel px-2 text-sm text-command-text placeholder:text-command-muted"
                      aria-label="Search Slack channels"
                    />
                    <div className="max-h-60 space-y-1 overflow-y-auto">
                      {filteredSlackChannels.map((channel) => {
                        const selected = slackChannelInput === channel.id;
                        return (
                          <button
                            key={channel.id}
                            type="button"
                            onClick={() => {
                              setSlackChannelInput(channel.id);
                              setSlackConfigMessage(
                                !channel.is_private || channel.is_member
                                  ? `Selected #${channel.name}.`
                                  : `Selected #${channel.name}. Invite Murphy to the channel before posting.`
                              );
                            }}
                            className={`w-full rounded border px-3 py-2 text-left text-sm transition ${
                              selected
                                ? "border-command-green bg-command-green/10 text-command-text"
                                : "border-command-line bg-command-panel text-command-muted hover:border-command-blue hover:text-command-text"
                            }`}
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="truncate">#{channel.name}</span>
                              <span className="shrink-0 text-[11px]">
                                {channel.is_private ? "private" : "public"}
                              </span>
                            </span>
                            <span className="mt-1 block truncate text-[11px] text-command-muted">
                              {!channel.is_private || channel.is_member
                                ? "Murphy can post here"
                                : "Invite Murphy before posting"}{" "}
                              / {channel.id}
                            </span>
                          </button>
                        );
                      })}
                      {!filteredSlackChannels.length ? (
                        <p className="rounded border border-command-line bg-command-panel px-3 py-2 text-xs text-command-muted">
                          No matching channels.
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <input
                    value={slackChannelInput}
                    onChange={(event) => setSlackChannelInput(event.target.value)}
                    placeholder="Channel ID, e.g. C012ABC"
                    className="min-h-10 w-full rounded border border-command-line bg-command-panel px-2 text-sm text-command-text placeholder:text-command-muted"
                  />
                )}
                <button
                  type="button"
                  onClick={() => void saveSlackChannel()}
                  disabled={!slackChannelInput.trim()}
                  className="min-h-10 w-full rounded border border-command-line bg-command-panel px-3 text-sm font-medium hover:border-command-blue disabled:cursor-not-allowed disabled:opacity-45"
                >
                  Save {selectedSlackChannel ? `#${selectedSlackChannel.name}` : "Channel"}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs leading-5 text-command-muted">
                  Connect Murphy with Slack OAuth so users can hand it tasks from a thread.
                </p>
                <a
                  href="/api/slack/install"
                  className="flex min-h-10 w-full items-center justify-center gap-2 rounded border border-command-line bg-command-panel px-3 text-sm font-medium text-command-text hover:border-command-green"
                >
                  <Send className="h-4 w-4 text-command-green" />
                  Connect Slack
                </a>
                {slackConnection?.missing_config?.length ? (
                  <p className="text-xs leading-5 text-command-amber">
                    Missing: {slackConnection.missing_config.join(", ")}
                  </p>
                ) : null}
                {slackConnection?.redirect_uri ? (
                  <p className="break-all text-xs leading-5 text-command-muted">
                    Redirect URL: {slackConnection.redirect_uri}
                  </p>
                ) : null}
              </div>
            )}
            {slackConfigMessage ? <p className="mt-3 text-xs leading-5 text-command-amber">{slackConfigMessage}</p> : null}
          </section>

          <div className="space-y-3">
            <ActionButton
              icon={<Send className="h-4 w-4 text-command-green" />}
              label={state.slackStatus === "posting" ? "Posting" : "Post Slack"}
              onClick={() => void sendSlack()}
              disabled={!task || state.slackStatus === "posting"}
            />
            <ActionButton
              icon={<GitPullRequest className="h-4 w-4 text-command-amber" />}
              label={
                taskProfileIsReadOnly
                  ? "PR disabled in read-only"
                  : state.prStatus === "opening"
                    ? "Opening PR"
                    : state.prStatus === "opened"
                      ? "PR opened"
                      : "Open PR"
              }
              onClick={() => void triggerOpenPR()}
              disabled={!canOpenPR || state.prStatus === "opening"}
            />
            {state.prUrl ? (
              <a
                href={state.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-10 w-full items-center justify-center gap-2 rounded border border-command-green bg-command-panel px-3 text-xs text-command-green hover:border-command-blue"
              >
                <GitBranch className="h-3.5 w-3.5" />
                View PR
              </a>
            ) : null}
          </div>

          <div className="mt-6 border-t border-command-line pt-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Activity className="h-4 w-4 text-command-blue" />
              Runtime
            </div>
            <dl className="space-y-3 text-sm text-command-muted">
              <div>
                <dt className="text-command-text">Voice</dt>
                <dd>{state.voiceStatus}</dd>
              </div>
              <div>
                <dt className="text-command-text">Codex</dt>
                <dd>{state.taskStatus}</dd>
              </div>
              <div>
                <dt className="text-command-text">PR</dt>
                <dd>{state.prStatus}</dd>
              </div>
              <div>
                <dt className="text-command-text">Slack</dt>
                <dd>{state.slackStatus}</dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>
    </main>
  );
}
