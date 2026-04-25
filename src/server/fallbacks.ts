import type { InvestigationResult, PostmortemDraft, IncidentLog } from "../shared/incident";

export const fallbackInvestigation: InvestigationResult = {
  root_cause:
    "The 3pm payments-service deploy introduced a NOT NULL payment_method_id migration against existing rows without that value, causing payment creation writes to fail and surface as 503s.",
  confidence: 0.92,
  evidence: [
    "git diff shows migrations/20260425_add_payment_method_not_null.sql adding ALTER TABLE payments ALTER COLUMN payment_method_id SET NOT NULL.",
    "logs/payments-service.log contains repeated not_null_violation errors for payment_method_id immediately after the deploy.",
    "health/dependencies.json shows database connectivity is healthy, narrowing the failure to application writes rather than an outage."
  ],
  recommended_action:
    "Roll back the migration or ship a backfill plus nullable transition, then verify payment creation and latency before resolving.",
  spoken_summary:
    "Found the likely root cause. The deploy added a NOT NULL payment_method_id constraint while existing rows still have nulls. Payment writes are failing, so the fastest mitigation is to roll back that migration and verify payment creation.",
  used_fallback: true
};

export function fallbackPostmortem(incident: IncidentLog): PostmortemDraft {
  const finding = incident.timeline.find((event) => event.type === "finding");
  return {
    root_cause:
      finding?.content ??
      "A payments-service schema migration introduced an unsafe NOT NULL constraint and caused write failures.",
    timeline_summary: incident.timeline
      .map((event) => `${new Date(event.timestamp).toLocaleTimeString()} - ${event.content}`)
      .join("\n"),
    contributing_factors: [
      "Migration did not include a backfill step before enforcing NOT NULL.",
      "Deploy health checks did not exercise the payment creation write path.",
      "The issue was detected from user-facing 503s instead of pre-release validation."
    ],
    action_items: [
      "Add migration safety checks for NOT NULL constraints on populated tables.",
      "Add post-deploy synthetic payment creation verification.",
      "Document rollback criteria for payments-service schema changes."
    ]
  };
}
