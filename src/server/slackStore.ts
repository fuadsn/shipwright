import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SlackInstall } from "./types";
import { demoRoot } from "./demoWorkspace";

const installPath = path.join(demoRoot, "slack-install.json");

export function loadSlackInstall(): SlackInstall | null {
  if (!existsSync(installPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(installPath, "utf8")) as SlackInstall;
  } catch {
    return null;
  }
}

export function saveSlackInstall(install: SlackInstall | null) {
  if (!install) {
    return;
  }

  mkdirSync(demoRoot, { recursive: true });
  writeFileSync(installPath, JSON.stringify(install, null, 2), { mode: 0o600 });
}
