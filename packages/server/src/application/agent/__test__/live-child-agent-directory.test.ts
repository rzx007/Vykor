import { describe, expect, it, vi } from "vitest";

import { LiveChildAgentDirectory } from "../live-child-agent-directory.js";

describe("LiveChildAgentDirectory", () => {
  it("routes through the framework-owned child directory without copying controls", async () => {
    const send = vi.fn(async () => ({ sessionId: "child-session", inputId: "input-1", runId: "run-1" }));
    const interrupt = vi.fn(async () => {});
    const interruptRun = vi.fn(async (_runId: string) => true);
    const child = { send, interrupt, interruptRun };
    const rootAgent = {
      id: "root-session",
      children: { get: vi.fn(() => child) },
    } as any;
    const directory = new LiveChildAgentDirectory();
    directory.register("child-session", "child-1", rootAgent);

    await expect(directory.send("child-session", { content: "follow up" })).resolves.toMatchObject({ inputId: "input-1" });
    await expect(directory.interrupt("child-session", "stop")).resolves.toBe(true);
    expect(directory.resolveRootSessionId("child-session")).toBe("root-session");
    expect(rootAgent.children.get).toHaveBeenCalledWith("child-1");
    expect(send).toHaveBeenCalledWith({ content: "follow up" });
    expect(interrupt).toHaveBeenCalledWith("stop");
    expect(await directory.interruptRun("child-session", "precise-run", "goal stopped")).toBe(true);
    expect(interruptRun).toHaveBeenCalledWith("precise-run", "goal stopped");

    directory.unregister("child-session", "child-1");
    expect(directory.has("child-session")).toBe(false);
    expect(directory.resolveRootSessionId("child-session")).toBeUndefined();
    expect(await directory.interruptRun("child-session", "precise-run")).toBe(false);
  });

  it("maps nested live child sessions to the same root without authorizing unknown sessions", () => {
    const children = new Map([
      ["child-1", {}],
      ["nested-child", {}],
    ]);
    const rootAgent = {
      id: "root-session",
      children: { get: vi.fn((childId: string) => children.get(childId)) },
    } as any;
    const directory = new LiveChildAgentDirectory();
    directory.register("child-session", "child-1", rootAgent);
    directory.register("nested-session", "nested-child", rootAgent);

    expect(directory.resolveRootSessionId("child-session")).toBe("root-session");
    expect(directory.resolveRootSessionId("nested-session")).toBe("root-session");
    expect(directory.resolveRootSessionId("unknown-session")).toBeUndefined();

    children.delete("nested-child");
    expect(directory.resolveRootSessionId("nested-session")).toBeUndefined();
  });

  it("removes stale entries while checking liveness", () => {
    const rootAgent = { children: { get: vi.fn(() => undefined) } } as any;
    const directory = new LiveChildAgentDirectory();
    directory.register("child-session", "child-1", rootAgent);

    expect(directory.has("child-session")).toBe(false);
    expect(rootAgent.children.get).toHaveBeenCalledWith("child-1");
  });
});
