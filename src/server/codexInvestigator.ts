import { spawn } from "node:child_process";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { IncidentLog, InvestigationResult } from "../shared/incident";
import { fallbackInvestigation } from "./fallbacks";
import { demoRoot, ensureDemoWorkspace } from "./demoWorkspace";

const investigationSchema = z.object({
  root_cause: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1)).min(1),
  recommended_action: z.string().min(1),
  spoken_summary: z.string().min(1)
});

const jsonSchema = {
  type: "object",
  properties: {
    root_cause: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", items: { type: "string" } },
    recommended_action: { type: "string" },
    spoken_summary: { type: "string" }
  },
  required: ["root_cause", "confidence", "evidence", "recommended_action", "spoken_summary"],
  additionalProperties: false
};

export function parseCodexInvestigation(raw: string): InvestigationResult {
  const parsed = investigationSchema.parse(JSON.parse(raw));
  return { ...parsed, used_fallback: false, raw_output: raw };
}

function buildPrompt(incident: IncidentLog): string {
  return [
    "You are the investigation engine for a hackathon incident response demo.",
    "Inspect only this local seeded payments-service repository. Do not edit files.",
    "",
    "Incident context:",
    `Service: ${incident.header.service}`,
    `Symptom: ${incident.header.symptom}`,
    `Severity: ${incident.header.severity}`,
    `Suspected trigger: ${incident.header.suspected_trigger}`,
    "",
    "Tasks:",
    "1. Inspect recent git commits and the latest diff.",
    "2. Inspect migrations for schema changes.",
    "3. Inspect logs/payments-service.log for errors around payment creation.",
    "4. Inspect health/dependencies.json for dependency status and rollback availability.",
    "5. Return only the structured JSON matching the provided schema.",
    "",
    "The final answer should be concise, cite concrete evidence, and recommend the safest next action."
  ].join("\n");
}

async function runCodex(repo: string, incident: IncidentLog, timeoutMs: number): Promise<string> {
  await mkdir(demoRoot, { recursive: true });
  const schemaPath = path.join(demoRoot, "codex-investigation.schema.json");
  const outputPath = path.join(demoRoot, "codex-investigation-output.json");
  await writeFile(schemaPath, JSON.stringify(jsonSchema, null, 2));

  const args = [
    "exec",
    "--json",
    "--output-schema",
    schemaPath,
    "-o",
    outputPath,
    buildPrompt(incident)
  ];

  return await new Promise<string>((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex investigation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Codex exited with ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(await readFile(outputPath, "utf8"));
      } catch {
        resolve(stdout.trim());
      }
    });
  });
}

export async function investigateWithCodex(incident: IncidentLog): Promise<InvestigationResult> {
  const timeoutMs = Number(process.env.CODEX_TIMEOUT_MS ?? 75000);

  try {
    const repo = await ensureDemoWorkspace();
    const raw = await runCodex(repo, incident, timeoutMs);
    return parseCodexInvestigation(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...fallbackInvestigation,
      raw_output: message
    };
  }
}
