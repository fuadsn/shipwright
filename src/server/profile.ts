import type { SafetyMode, TaskAllowedAction } from "../shared/task";

export type ProfileName = "prod" | "staging" | "free";

export interface MurphyProfile {
  name: ProfileName;
  label: string;
  search_roots: string[];
  safety_mode: SafetyMode;
  allowed_actions: TaskAllowedAction[];
  enforce: "advisory" | "strict";
  description: string;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

export function buildProfiles(env: NodeJS.ProcessEnv = process.env): Record<ProfileName, MurphyProfile> {
  return {
    prod: {
      name: "prod",
      label: env.MURPHY_PROD_LABEL ?? "prod (read-only)",
      search_roots: parseList(env.MURPHY_PROD_PATH, ["~/Projects"]),
      safety_mode: "read_only",
      allowed_actions: ["read"],
      enforce: "advisory",
      description: "Production read-only profile. Inspect only — never modify."
    },
    staging: {
      name: "staging",
      label: env.MURPHY_STAGING_LABEL ?? "staging (read-write)",
      search_roots: parseList(env.MURPHY_STAGING_PATH, ["~/Projects"]),
      safety_mode: "edit_local",
      allowed_actions: ["read", "edit", "test", "git"],
      enforce: "advisory",
      description: "Staging read-write profile. Edit, run tests, commit on a new branch."
    },
    free: {
      name: "free",
      label: env.MURPHY_FREE_LABEL ?? "free",
      search_roots: parseList(env.MURPHY_SEARCH_ROOTS, ["~/Projects"]),
      safety_mode: "edit_local",
      allowed_actions: ["read", "edit", "test", "git"],
      enforce: "advisory",
      description: "Default profile when the user does not specify prod or staging."
    }
  };
}

export function defaultProfileName(env: NodeJS.ProcessEnv = process.env): ProfileName {
  const requested = (env.MURPHY_PROFILE ?? "free").toLowerCase();
  if (requested === "prod" || requested === "staging" || requested === "free") {
    return requested;
  }
  return "free";
}

export function resolveProfile(name?: string, env: NodeJS.ProcessEnv = process.env): MurphyProfile {
  const profiles = buildProfiles(env);
  const key = (name ?? defaultProfileName(env)).toLowerCase();
  if (key === "prod" || key === "staging" || key === "free") {
    return profiles[key];
  }
  return profiles[defaultProfileName(env)];
}

export function profilePromptHints(profiles: Record<ProfileName, MurphyProfile>, defaultName: ProfileName): string[] {
  const lines = [
    "You can choose between three access profiles per task. Pass the profile name in run_codex_task and open_pr.",
    `- "prod" -> ${profiles.prod.label}. Read-only. Search roots: ${profiles.prod.search_roots.join(", ")}.`,
    `- "staging" -> ${profiles.staging.label}. Read-write. Search roots: ${profiles.staging.search_roots.join(", ")}.`,
    `- "free" -> ${profiles.free.label}. Default. Search roots: ${profiles.free.search_roots.join(", ")}.`,
    "How to pick:",
    "- If the user says 'prod', 'production', 'investigate', 'look at', or asks for a report, use prod (read-only).",
    "- If the user says 'staging', 'fix', 'patch', 'edit', 'add', 'refactor', 'implement', use staging.",
    "- If the user names a different folder explicitly, use free and pass search_roots.",
    "- DO NOT call open_pr when the active profile is prod. If the user asks for a PR while in prod, refuse and suggest re-running in staging.",
    `Default profile if the user does not say: ${defaultName}.`
  ];
  return lines;
}

export function codexPromptHints(profile: MurphyProfile, requestedSafetyMode: SafetyMode): string[] {
  if (requestedSafetyMode === "read_only" || profile.safety_mode === "read_only") {
    return [
      "STRICT READ-ONLY MODE.",
      "DO NOT modify any file.",
      "DO NOT create, rename, move, or delete files.",
      "DO NOT run shell commands that mutate state (no `git commit`, `git checkout -b`, `npm install`, etc.).",
      "ONLY read files, search, run read-only inspection commands (ls, cat, grep, git log, git diff).",
      "If the task requires changes, set status to failed and explain in the summary that this profile is read-only."
    ];
  }
  return [];
}
