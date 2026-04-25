import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

const checks: CheckResult[] = [];
const record = (result: CheckResult) => checks.push(result);

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function runCmd(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    if (r.error) return { ok: false, out: r.error.message };
    return { ok: r.status === 0, out: (r.stdout || r.stderr || "").trim() };
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error) };
  }
}

function envCheck(key: string, hint?: string) {
  const value = process.env[key];
  record({
    name: `env: ${key}`,
    ok: Boolean(value && value.trim()),
    detail: value && value.trim() ? "set" : "missing",
    hint
  });
}

// Required env
envCheck("OPENAI_API_KEY", "needed for Realtime voice; add to .env");
envCheck("SLACK_SIGNING_SECRET", "needed to verify Slack events; without it #issues messages are rejected");
envCheck("SLACK_CLIENT_ID", "Slack OAuth");
envCheck("SLACK_CLIENT_SECRET", "Slack OAuth");
envCheck("MURPHY_STAGING_PATH", "the repo Codex will edit; set to an absolute path");
envCheck("MURPHY_PROD_PATH", "the repo Codex inspects in prod (read-only)");

// CLI deps
{
  const r = runCmd("codex", ["--version"]);
  record({
    name: "codex CLI",
    ok: r.ok,
    detail: r.ok ? r.out.split("\n")[0] : "not on PATH",
    hint: r.ok ? undefined : "install the OpenAI codex CLI and put it on PATH; or override CODEX_EXEC_ARGS"
  });
}
{
  const r = runCmd("gh", ["--version"]);
  record({
    name: "gh CLI installed",
    ok: r.ok,
    detail: r.ok ? r.out.split("\n")[0] : "not on PATH",
    hint: r.ok ? undefined : "brew install gh"
  });
}
{
  const r = runCmd("gh", ["auth", "status"]);
  record({
    name: "gh authenticated",
    ok: r.ok,
    detail: r.ok ? "logged in" : r.out.split("\n")[0] ?? "not logged in",
    hint: r.ok ? undefined : "run `gh auth login`"
  });
}

// Path checks for staging / prod
function pathCheck(label: string, raw?: string) {
  if (!raw) return;
  const abs = expandHome(raw);
  const exists = existsSync(abs);
  record({
    name: `${label} path`,
    ok: exists,
    detail: abs,
    hint: exists ? undefined : "edit .env so the path points to an existing folder"
  });
  if (!exists) return;

  const isGit = existsSync(path.join(abs, ".git"));
  record({
    name: `${label} is git repo`,
    ok: isGit,
    detail: isGit ? ".git found" : "no .git in this folder",
    hint: isGit ? undefined : "run `git init` in that folder if it should be a repo"
  });
  if (!isGit) return;

  const remote = runCmd("git", ["-C", abs, "remote", "get-url", "origin"]);
  const isGithub = remote.ok && /github\.com/.test(remote.out);
  record({
    name: `${label} GitHub origin`,
    ok: isGithub,
    detail: remote.ok ? remote.out : "no origin set",
    hint: isGithub
      ? undefined
      : "the PR step needs a GitHub origin you can push to; add one with `git remote add origin <url>`"
  });
}

pathCheck("staging", process.env.MURPHY_STAGING_PATH);
pathCheck("prod", process.env.MURPHY_PROD_PATH);

// Slack signing-secret + redirect URI sanity
if (process.env.SLACK_REDIRECT_URI) {
  const looksHttps = /^https:\/\//.test(process.env.SLACK_REDIRECT_URI);
  record({
    name: "SLACK_REDIRECT_URI is HTTPS",
    ok: looksHttps,
    detail: process.env.SLACK_REDIRECT_URI,
    hint: looksHttps ? undefined : "Slack requires HTTPS; use ngrok or Cloudflare Tunnel for local dev"
  });
}

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)} ` : s.padEnd(n));

console.log("\nMurphy preflight\n");
console.log(`${pad("CHECK", 30)}${pad("STATUS", 8)}DETAIL`);
console.log("-".repeat(80));
for (const c of checks) {
  const status = c.ok ? `${GREEN}OK${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`${pad(c.name, 30)}${pad(status, 8 + (c.ok ? GREEN.length + RESET.length : RED.length + RESET.length))}${c.detail}`);
  if (!c.ok && c.hint) {
    console.log(`${" ".repeat(30)}${DIM}-> ${c.hint}${RESET}`);
  }
}

const failed = checks.filter((c) => !c.ok);
console.log();
if (failed.length) {
  console.log(`${RED}${failed.length} issue${failed.length === 1 ? "" : "s"} to fix before the demo.${RESET}\n`);
  process.exit(1);
}
console.log(`${GREEN}All prereqs satisfied. Murphy is ready.${RESET}\n`);
