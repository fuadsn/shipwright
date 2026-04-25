import { EventEmitter } from "node:events";
import httpMocks from "node-mocks-http";
import { describe, expect, it } from "vitest";
import { app } from "../src/server/index";

describe("server endpoints", () => {
  async function invoke(method: string, url: string, body?: unknown) {
    const req = httpMocks.createRequest({
      method: method as "GET" | "POST",
      url,
      headers: { "content-type": "application/json" },
      body: body as Record<string, unknown> | undefined
    });
    const res = httpMocks.createResponse({ eventEmitter: EventEmitter });

    await new Promise<void>((resolve) => {
      res.on("end", resolve);
      (app as unknown as { handle: (request: typeof req, response: typeof res) => void }).handle(req, res);
    });

    return {
      status: res.statusCode,
      body: res._getJSONData()
    };
  }

  it("reports health", async () => {
    const response = await invoke("GET", "/api/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it("returns no_active_task when opening a PR with no active task", async () => {
    const response = await invoke("POST", "/api/tools/codex/open-pr", {});
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("no_active_task");
  });

  it("rejects run with no task body", async () => {
    const response = await invoke("POST", "/api/tools/codex/run", {});
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("task is required");
  });
});
