import type { IncidentLog, PostmortemDraft } from "../shared/incident";
import { fallbackPostmortem } from "./fallbacks";

export async function generatePostmortem(incident: IncidentLog): Promise<PostmortemDraft> {
  if (!process.env.OPENAI_API_KEY) {
    return fallbackPostmortem(incident);
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        input: [
          {
            role: "system",
            content:
              "Generate a concise incident postmortem draft. Return only JSON with root_cause, timeline_summary, contributing_factors, action_items."
          },
          {
            role: "user",
            content: JSON.stringify(incident)
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "postmortem_draft",
            schema: {
              type: "object",
              properties: {
                root_cause: { type: "string" },
                timeline_summary: { type: "string" },
                contributing_factors: { type: "array", items: { type: "string" } },
                action_items: { type: "array", items: { type: "string" } }
              },
              required: ["root_cause", "timeline_summary", "contributing_factors", "action_items"],
              additionalProperties: false
            }
          }
        }
      })
    });

    if (!response.ok) {
      return fallbackPostmortem(incident);
    }

    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const outputText =
      data.output_text ??
      data.output?.flatMap((item) => item.content ?? []).find((content) => content.text)?.text;

    if (!outputText) {
      return fallbackPostmortem(incident);
    }

    return JSON.parse(outputText) as PostmortemDraft;
  } catch {
    return fallbackPostmortem(incident);
  }
}
