import type { StreamingMessageClient } from "@vykor/agent-contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";

import { createDefaultNodeAgent } from "../runtime/default-agent.js";
import { FileWorkflowRunRepository } from "./file-workflow-run-repository.js";

it("closes the workflow owner before removing its real child workers", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vykor-workflow-close-"));
  const previous = process.env.VYKOR_CONFIG_DIR;
  process.env.VYKOR_CONFIG_DIR = join(cwd, "config");
  let childStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    childStarted = resolve;
  });
  let sawAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    sawAbort = resolve;
  });
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: StreamingMessageClient = {
    async *streamMessage(request) {
      const last = request.messages.at(-1)!;
      const text =
        typeof last.content === "string"
          ? last.content
          : last.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      if (last.type === "user" && text.includes("wait-for-owner-close")) {
        childStarted();
        await new Promise<void>((resolve) => {
          request.abortSignal!.addEventListener(
            "abort",
            () => {
              sawAbort();
              resolve();
            },
            { once: true },
          );
          if (request.abortSignal!.aborted) {
            sawAbort();
            resolve();
          }
        });
        await cleanup;
        throw new Error("child interrupted");
      }
      if (last.type === "user" && text === "start") {
        yield {
          type: "tool_use_start",
          toolUse: {
            type: "tool_use",
            id: "workflow",
            name: "Workflow",
            input: {
              mode: "parallel",
              runId: "closing",
              tasks: [{ id: "worker", prompt: "wait-for-owner-close" }],
            },
          },
        };
        yield { type: "complete", stopReason: "tool_use" };
        return;
      }
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
  const agent = await createDefaultNodeAgent({
    cwd,
    client,
    pluginsEnabled: false,
    systemPrompt: "test",
    settings: {
      model: "test",
      apiFormat: "anthropic",
      maxTurns: 3,
      permission: { mode: "full_auto" },
      sandbox: { enabled: false },
      memory: { enabled: false },
    },
    capabilityOverrides: {
      terminal: false,
      backgroundShell: false,
      memory: false,
    },
  });
  try {
    await agent.runMessage("start");
    await started;
    let closed = false;
    const closing = agent.close().then(() => {
      closed = true;
    });
    await aborted;
    expect(closed).toBe(false);
    release();
    await closing;
    expect(
      new FileWorkflowRunRepository({ cwd }).load("closing"),
    ).toMatchObject({ status: "failed", termination: "cancelled" });
  } finally {
    release();
    await agent.close();
    if (previous === undefined) delete process.env.VYKOR_CONFIG_DIR;
    else process.env.VYKOR_CONFIG_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});
