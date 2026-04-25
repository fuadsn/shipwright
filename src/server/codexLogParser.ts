export interface ParsedStep {
  content: string;
  category: "agent" | "tool" | "file" | "shell" | "error" | "info";
  evidence?: string[];
  drop?: boolean;
}

const ANSI_PATTERN = /\[[0-9;]*[a-zA-Z]/g;
const SEPARATOR_PATTERN = /^[\s\-=*_~#]+$/;
const NOISE_PATTERNS = [
  /^thinking\.{2,}$/i,
  /^\.+$/,
  /^\s*$/,
  /^\[(info|debug)\]\s*$/i
];

const MAX_CONTENT_LEN = 240;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "").trimEnd();
}

function truncate(text: string, max = MAX_CONTENT_LEN): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function categorize(line: string): ParsedStep["category"] {
  const lower = line.toLowerCase();
  if (/\b(error|failed|fatal|exception|traceback|panic)\b/i.test(line)) return "error";
  if (/^\[stderr\]/.test(line)) return "error";
  if (/^\$\s|^>\s|\b(npm|pnpm|yarn|bun|pytest|cargo|go test|uvicorn|python|node|tsc|vitest|gh|git)\s/.test(lower)) return "shell";
  if (/(read|edit|edit_file|write|patch|create|delete|moved|renamed)[:\s]+[\w./~-]+/i.test(line)) return "file";
  if (/\b(tool_call|function_call|invoking|calling)\b/i.test(lower)) return "tool";
  return "info";
}

export function parseCodexLine(rawLine: string, structured?: Record<string, unknown>): ParsedStep {
  const line = stripAnsi(rawLine).trim();

  if (!line) return { content: "", category: "info", drop: true };
  if (SEPARATOR_PATTERN.test(line)) return { content: line, category: "info", drop: true };
  if (NOISE_PATTERNS.some((re) => re.test(line))) return { content: line, category: "info", drop: true };

  if (structured && typeof structured.type === "string") {
    const type = structured.type;
    if (type === "agent_message" && typeof structured.message === "string") {
      return { content: truncate(structured.message), category: "agent" };
    }
    if (type === "tool_call" || type === "function_call") {
      const name = typeof structured.name === "string" ? structured.name : "tool";
      const argText = typeof structured.arguments === "string" ? structured.arguments : "";
      const evidence = argText ? [truncate(argText, 160)] : undefined;
      return { content: `Codex ran ${name}`, category: "tool", evidence };
    }
    if (type === "error" || type === "exception") {
      const msg = typeof structured.message === "string" ? structured.message : line;
      return { content: truncate(msg), category: "error" };
    }
  }

  return { content: truncate(line), category: categorize(line) };
}

export interface LogStreamFilter {
  ingest: (line: string, structured?: Record<string, unknown>) => ParsedStep | null;
  flush: () => ParsedStep[];
}

// Deduplicates consecutive identical (or near-identical) lines and coalesces short bursts.
export function createLogStreamFilter(): LogStreamFilter {
  let lastContent: string | null = null;
  let repeatCount = 0;

  return {
    ingest(line, structured) {
      const parsed = parseCodexLine(line, structured);
      if (parsed.drop) return null;
      if (parsed.content === lastContent) {
        repeatCount += 1;
        if (repeatCount === 1 || repeatCount % 25 === 0) {
          return { ...parsed, content: `${parsed.content} (x${repeatCount + 1})` };
        }
        return null;
      }
      lastContent = parsed.content;
      repeatCount = 0;
      return parsed;
    },
    flush() {
      const tail: ParsedStep[] = [];
      if (repeatCount > 0 && lastContent) {
        tail.push({ content: `${lastContent} (x${repeatCount + 1})`, category: "info" });
      }
      lastContent = null;
      repeatCount = 0;
      return tail;
    }
  };
}
