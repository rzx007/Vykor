import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isSimpleMode,
  matchSessionMode,
  getCoordinatorTools,
  getCoordinatorUserContext,
  getCoordinatorSystemPrompt,
} from "../coordinator-mode.js";

beforeEach(() => {
  delete process.env.VYKOR_COORDINATOR_MODE;
  delete process.env.VYKOR_COORDINATOR_SIMPLE;
});

afterEach(() => {
  delete process.env.VYKOR_COORDINATOR_MODE;
  delete process.env.VYKOR_COORDINATOR_SIMPLE;
});

describe("matchSessionMode", () => {
  it("returns undefined when modes already match or no session mode", () => {
    expect(matchSessionMode(undefined)).toBeUndefined();
    expect(matchSessionMode("normal")).toBeUndefined(); // both non-coordinator
    process.env.VYKOR_COORDINATOR_MODE = "1";
    expect(matchSessionMode("coordinator")).toBeUndefined();
  });

  it("enters coordinator mode to match a resumed coordinator session", () => {
    const warning = matchSessionMode("coordinator");
    expect(warning).toContain("Entered coordinator mode");
    expect(process.env.VYKOR_COORDINATOR_MODE).toBe("1");
  });

  it("exits coordinator mode to match a resumed normal session", () => {
    process.env.VYKOR_COORDINATOR_MODE = "true";
    const warning = matchSessionMode("normal");
    expect(warning).toContain("Exited coordinator mode");
    expect(process.env.VYKOR_COORDINATOR_MODE).toBeUndefined();
  });
});

describe("getCoordinatorTools", () => {
  it("reserves orchestration tools for the coordinator", () => {
    expect(getCoordinatorTools()).toEqual([
      "Agent",
      "JobList",
      "JobRead",
      "JobWait",
      "JobSend",
      "JobCancel",
      "Workflow",
    ]);
  });
});

describe("getCoordinatorUserContext", () => {
  it("returns {} outside coordinator mode", () => {
    expect(getCoordinatorUserContext()).toEqual({});
  });

  it("can be enabled explicitly by a session-owned host", () => {
    const ctx = getCoordinatorUserContext([{ name: "db" }], undefined, { enabled: true });
    expect(ctx.workerToolsContext).toContain("MCP servers: db");
  });

  it("lists worker tools, MCP servers, and scratchpad when provided", () => {
    process.env.VYKOR_COORDINATOR_MODE = "1";
    const ctx = getCoordinatorUserContext([{ name: "db" }, { name: "web" }], "/tmp/pad");
    const content = ctx.workerToolsContext!;
    expect(content).toContain("Shell");
    expect(content).toContain("Skill");
    expect(content).toContain("JobList");
    expect(content).toContain("JobRead");
    expect(content).not.toContain("TaskList");
    expect(content).toContain("MCP servers: db, web");
    expect(content).toContain("Scratchpad directory: /tmp/pad");
  });

  it("simple mode narrows the worker tool list", () => {
    process.env.VYKOR_COORDINATOR_MODE = "1";
    process.env.VYKOR_COORDINATOR_SIMPLE = "true";
    expect(isSimpleMode()).toBe(true);
    const content = getCoordinatorUserContext().workerToolsContext!;
    expect(content).toContain("Edit, Read, Shell");
    expect(content).not.toContain("WebSearch");
  });

  it("filters the worker tool list by the host tool ceiling", () => {
    const content = getCoordinatorUserContext([], undefined, {
      enabled: true,
      hostToolCeiling: ["Read", "Grep"],
    }).workerToolsContext!;

    expect(content).toContain("Grep, Read");
    expect(content).not.toContain("Shell");
    expect(content).not.toContain("Edit");
  });

  it("says when the host tool ceiling leaves workers with no standard tools", () => {
    const content = getCoordinatorUserContext([], undefined, {
      enabled: true,
      hostToolCeiling: ["Agent", "Workflow"],
    }).workerToolsContext!;

    expect(content).toContain("do not have access to any standard tools");
  });
});

describe("getCoordinatorSystemPrompt", () => {
  it("RICH_CAPABILITIES stays in sync with the static prompt (replace guard)", async () => {
    const { COORDINATOR_SYSTEM_PROMPT } = await import("../index.js");
    const { RICH_CAPABILITIES } = await import("../coordinator-mode.js");
    expect(COORDINATOR_SYSTEM_PROMPT).toContain(RICH_CAPABILITIES);
  });

  it("uses the rich worker capabilities by default", () => {
    const prompt = getCoordinatorSystemPrompt();
    expect(prompt).toContain("project skills via the Skill tool");
    expect(prompt).toContain("Workflow");
    expect(prompt).toContain("## 1. Your Role");
  });

  it("swaps in the simple capabilities under VYKOR_COORDINATOR_SIMPLE", () => {
    process.env.VYKOR_COORDINATOR_SIMPLE = "1";
    const prompt = getCoordinatorSystemPrompt();
    expect(prompt).toContain("Workers have access to Shell, Read, and Edit tools");
    expect(prompt).not.toContain("project skills via the Skill tool");
  });
});
