import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const demoRoot = path.resolve(process.cwd(), ".demo");
export const paymentsRepo = path.join(demoRoot, "payments-service");

async function git(args: string[], cwd = paymentsRepo) {
  await execFileAsync("git", args, { cwd });
}

export async function ensureDemoWorkspace(force = false): Promise<string> {
  if (force && existsSync(demoRoot)) {
    await rm(demoRoot, { recursive: true, force: true });
  }

  if (existsSync(path.join(paymentsRepo, ".git"))) {
    return paymentsRepo;
  }

  await mkdir(path.join(paymentsRepo, "src"), { recursive: true });
  await mkdir(path.join(paymentsRepo, "migrations"), { recursive: true });
  await mkdir(path.join(paymentsRepo, "logs"), { recursive: true });
  await mkdir(path.join(paymentsRepo, "health"), { recursive: true });

  await execFileAsync("git", ["init"], { cwd: paymentsRepo });
  await git(["config", "user.email", "demo@incident-commander.local"]);
  await git(["config", "user.name", "Incident Commander Demo"]);

  await writeFile(
    path.join(paymentsRepo, "package.json"),
    JSON.stringify({ name: "payments-service", version: "1.2.3", type: "module" }, null, 2)
  );
  await writeFile(
    path.join(paymentsRepo, "src", "createPayment.ts"),
    [
      "export function createPayment(input) {",
      "  return { id: crypto.randomUUID(), status: 'created', ...input };",
      "}",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(paymentsRepo, "migrations", "20260425_add_payment_method.sql"),
    [
      "-- Safe first step: add nullable payment_method_id column.",
      "ALTER TABLE payments ADD COLUMN payment_method_id UUID;",
      ""
    ].join("\n")
  );
  await git(["add", "."]);
  await git(["commit", "-m", "Add payment method column"]);

  await writeFile(
    path.join(paymentsRepo, "migrations", "20260425_enforce_payment_method_not_null.sql"),
    [
      "-- Regression: existing rows have null payment_method_id values.",
      "ALTER TABLE payments ALTER COLUMN payment_method_id SET NOT NULL;",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(paymentsRepo, "logs", "payments-service.log"),
    [
      "2026-04-25T14:51:03Z ERROR request_id=req-1048 route=/payments status=503 duration_ms=1842 error=not_null_violation column=payment_method_id",
      "2026-04-25T14:51:07Z ERROR request_id=req-1052 route=/payments status=503 duration_ms=2110 error=insert_or_update_on_table_payments_violates_not_null_constraint",
      "2026-04-25T14:52:12Z WARN pool checkout latency p95=790ms service=payments-service",
      "2026-04-25T14:53:31Z ERROR request_id=req-1081 route=/payments status=503 duration_ms=2368 error=not_null_violation column=payment_method_id",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(paymentsRepo, "health", "dependencies.json"),
    JSON.stringify(
      {
        database: { status: "healthy", connections_used: 14, connections_max: 80 },
        stripe: { status: "healthy", p95_ms: 120 },
        ledger: { status: "healthy", p95_ms: 88 },
        deploy: {
          deployed_at: "2026-04-25T15:00:00+05:30",
          actor: "fuad",
          sha: "HEAD",
          rollback_available: true
        }
      },
      null,
      2
    )
  );
  await git(["add", "."]);
  await git(["commit", "-m", "Enforce payment method id for payments"]);

  return paymentsRepo;
}
