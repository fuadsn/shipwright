import { describe, expect, it } from "vitest";
import { createEvent, createIncidentId, demoIncidentHeader, type IncidentLog } from "../src/shared/incident";
import { buildSlackMessage, slackConnectionStatus } from "../src/server/slack";

function incident(): IncidentLog {
  return {
    id: createIncidentId(new Date("2026-04-25T09:30:00.000Z")),
    declared_at: "2026-04-25T09:30:00.000Z",
    resolved_at: null,
    mttr_seconds: null,
    header: demoIncidentHeader,
    timeline: [
      createEvent("declaration", "engineer", "Payments are 503ing.", undefined, new Date("2026-04-25T09:30:00.000Z")),
      createEvent("finding", "codex", "Migration is failing writes.", undefined, new Date("2026-04-25T09:31:00.000Z"))
    ],
    postmortem_draft: null
  };
}

describe("buildSlackMessage", () => {
  it("builds an incident update from the current log", () => {
    const message = buildSlackMessage(incident());

    expect(message).toContain("P1 Incident - payments-service");
    expect(message).toContain("Migration is failing writes.");
  });

  it("uses explicit message overrides", () => {
    expect(buildSlackMessage(incident(), "Custom update")).toBe("Custom update");
  });
});

describe("slackConnectionStatus", () => {
  it("reports oauth installs as connected", () => {
    const status = slackConnectionStatus({
      team_id: "T123",
      team_name: "Demo",
      bot_token: "xoxb-demo",
      bot_user_id: "U123",
      channel_id: "C123",
      channel_name: "incidents",
      installed_at: "2026-04-25T09:30:00.000Z"
    });

    expect(status.connected).toBe(true);
    expect(status.mode).toBe("oauth");
    expect(status.channel_name).toBe("incidents");
  });
});
