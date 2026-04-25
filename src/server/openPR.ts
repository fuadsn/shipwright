import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { OpenPRResult } from "../shared/task";

interface OpenPROptions {
  repo_path: string;
  branch?: string | null;
  title?: string;
  body?: string;
  base?: string;
  push?: boolean;
}

interface RunOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || (error instanceof Error ? error.message : String(error)) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function currentBranch(cwd: string): Promise<string | null> {
  const { code, stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (code !== 0) return null;
  return stdout.trim() || null;
}

function extractPrUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s)]+\/pull\/\d+/);
  return match ? match[0] : null;
}

export async function openPullRequest(opts: OpenPROptions): Promise<OpenPRResult> {
  if (!opts.repo_path || !existsSync(opts.repo_path)) {
    return {
      ok: false,
      pr_url: null,
      branch: opts.branch ?? null,
      repo_path: opts.repo_path ?? null,
      error: "missing_repo_path",
      message: "I do not have a valid repo path to open a PR from."
    };
  }

  const branch = opts.branch?.trim() || (await currentBranch(opts.repo_path));
  if (!branch) {
    return {
      ok: false,
      pr_url: null,
      branch: null,
      repo_path: opts.repo_path,
      error: "no_branch",
      message: "Could not determine the current branch in the working repo."
    };
  }

  if (opts.push !== false) {
    const push = await run("git", ["push", "-u", "origin", branch], opts.repo_path);
    if (push.code !== 0) {
      return {
        ok: false,
        pr_url: null,
        branch,
        repo_path: opts.repo_path,
        error: "git_push_failed",
        message: `git push failed: ${push.stderr || push.stdout || `exit ${push.code}`}`
      };
    }
  }

  const ghArgs = ["pr", "create", "--head", branch, "--fill"];
  if (opts.title) ghArgs.push("--title", opts.title);
  if (opts.body) ghArgs.push("--body", opts.body);
  if (opts.base) ghArgs.push("--base", opts.base);

  const pr = await run("gh", ghArgs, opts.repo_path, 90_000);
  if (pr.code !== 0) {
    return {
      ok: false,
      pr_url: null,
      branch,
      repo_path: opts.repo_path,
      error: "gh_pr_create_failed",
      message: `gh pr create failed: ${pr.stderr || pr.stdout || `exit ${pr.code}`}`
    };
  }

  const prUrl = extractPrUrl(`${pr.stdout}\n${pr.stderr}`);
  return {
    ok: true,
    pr_url: prUrl,
    branch,
    repo_path: opts.repo_path,
    error: null,
    message: prUrl ? `Pull request opened: ${prUrl}` : "Pull request opened."
  };
}
