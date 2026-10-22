import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ChildAgentExecutionRegistry } from "../index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ChildAgentExecutionRegistry", () => {
  it("registers framework callbacks without exposing process creation", async () => {
    const onInput = vi.fn(async () => {});
    const onStop = vi.fn(async () => {});
    const registry = new ChildAgentExecutionRegistry(tempDirectory());
    const execution = registry.registerChildExecution({
      id: "child-1",
      description: "review",
      cwd: process.cwd(),
      sessionId: "session-1",
      childSessionId: "child-session-1",
      prompt: "review this",
      onInput,
      onStop,
    });

    expect(execution).toMatchObject({ id: "child-1", backend: "child_agent", type: "agent" });
    expect("startShellExecution" in registry).toBe(false);
    await registry.writeInput(execution.id, "continue");
    expect(onInput).toHaveBeenCalledWith("continue");
    await registry.stopExecution(execution.id);
    expect(onStop).toHaveBeenCalledOnce();
    expect(registry.getExecution(execution.id)?.status).toBe("stopped");
  });

  it("records completion output and supports terminal waits", async () => {
    const registry = new ChildAgentExecutionRegistry(tempDirectory());
    registry.registerChildExecution({
      id: "child-2",
      description: "implement",
      cwd: process.cwd(),
      sessionId: "session-1",
      childSessionId: "child-session-2",
      prompt: "work",
      onInput: async () => {},
      onStop: async () => {},
    });
    const waited = registry.awaitExecution("child-2", { timeoutMs: 1_000 });
    await registry.completeExecution("child-2", { status: "completed", output: "done" });
    await expect(waited).resolves.toMatchObject({ status: "completed", output: "done" });
  });
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "vykor-child-registry-"));
  directories.push(directory);
  return directory;
}
