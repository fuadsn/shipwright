import { describe, expect, it } from "vitest";
import { buildCodexPrompt, expandHome, extractTaskResult } from "../src/server/codexRunner";

describe("extractTaskResult", () => {
  it("parses a MURPHY_RESULT JSON line at the end of output", () => {
    const raw = [
      "Searching ~/Projects",
      "Editing src/foo.ts",
      'MURPHY_RESULT: {"status":"succeeded","repo_path":"/r","branch":"murphy/x","files_changed":["src/foo.ts"],"tests_run":["npm test"],"summary":"Done.","errors":[]}'
    ].join("\n");

    const parsed = extractTaskResult(raw);
    expect(parsed?.status).toBe("succeeded");
    expect(parsed?.repo_path).toBe("/r");
    expect(parsed?.files_changed).toEqual(["src/foo.ts"]);
  });

  it("returns null when no MURPHY_RESULT line is present", () => {
    expect(extractTaskResult("just some plain text\nnothing structured here")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(extractTaskResult("MURPHY_RESULT: {not json}")).toBeNull();
  });
});

describe("buildCodexPrompt", () => {
  it("includes the user task and search roots", () => {
    const prompt = buildCodexPrompt({
      task: "Add dark mode",
      search_roots: ["~/code/site"]
    });
    expect(prompt).toContain("Add dark mode");
    expect(prompt).toContain("MURPHY_RESULT");
    expect(prompt).toMatch(/code\/site/);
  });
});

describe("expandHome", () => {
  it("leaves absolute paths alone", () => {
    expect(expandHome("/tmp/foo")).toBe("/tmp/foo");
  });

  it("expands a leading tilde", () => {
    const expanded = expandHome("~/Projects");
    expect(expanded.endsWith("/Projects")).toBe(true);
    expect(expanded.startsWith("/")).toBe(true);
  });
});
