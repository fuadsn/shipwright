export type Severity = "P1" | "P2" | "P3";

export type IncidentEventType =
  | "declaration"
  | "finding"
  | "action"
  | "escalation"
  | "resolution"
  | "system";

export type IncidentEventSource = "engineer" | "codex" | "system" | "slack";

export interface IncidentHeader {
  service: string;
  symptom: string;
  severity: Severity;
  suspected_trigger: string;
}

export interface IncidentEvent {
  id: string;
  timestamp: string;
  type: IncidentEventType;
  content: string;
  source: IncidentEventSource;
  evidence?: string[];
}

export interface PostmortemDraft {
  root_cause: string;
  timeline_summary: string;
  contributing_factors: string[];
  action_items: string[];
}

export interface IncidentLog {
  id: string;
  declared_at: string;
  resolved_at: string | null;
  mttr_seconds: number | null;
  header: IncidentHeader;
  timeline: IncidentEvent[];
  postmortem_draft: PostmortemDraft | null;
  slack_thread_ts?: string | null;
}

export interface InvestigationResult {
  root_cause: string;
  confidence: number;
  evidence: string[];
  recommended_action: string;
  spoken_summary: string;
  used_fallback: boolean;
  raw_output?: string;
}

export interface SlackPostResult {
  ok: boolean;
  message: string;
  thread_ts?: string;
  used_thread: boolean;
  error?: string;
}

export interface CloseIncidentResult {
  incident: IncidentLog;
  spoken_summary: string;
}

export const demoIncidentHeader: IncidentHeader = {
  service: "payments-service",
  symptom: "HTTP 503s and elevated latency on payment creation",
  severity: "P1",
  suspected_trigger: "3pm deploy introduced a schema migration"
};

export function createIncidentId(now = new Date()): string {
  const compactTimestamp = now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replaceAll("T", "")
    .replaceAll("Z", "")
    .slice(0, 14);
  return `inc-${compactTimestamp}`;
}

export function createEvent(
  type: IncidentEventType,
  source: IncidentEventSource,
  content: string,
  evidence?: string[],
  now = new Date()
): IncidentEvent {
  return {
    id: `${type}-${source}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: now.toISOString(),
    type,
    source,
    content,
    evidence
  };
}
