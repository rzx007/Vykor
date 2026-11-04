import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamingMessageClient } from "@vykor/agent-contracts";
import { createVykorRuntime } from "../default-runtime.js";

describe("communication in actual model requests", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "vykor-communication-")); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });
  it.each([undefined, "Exact host instructions."])("uses the expected default or explicit system prompt", async (systemPrompt) => {
    const prompts: string[] = [];
    const client: StreamingMessageClient = { async *streamMessage(input) {
      prompts.push(String(input.system));
      yield { type: "text_delta", delta: "finished" };
      yield { type: "complete", stopReason: "end_turn" };
    } };
    const runtime = await createVykorRuntime({ cwd, settings: { model: "test", apiFormat: "openai", permission: { mode: "default" }, sandbox: { enabled: false } }, configuration: { systemPrompt, client } });
    try {
      for await (const _ of runtime.queryEngine.submitMessage("explain")) { /* consume */ }
      if (systemPrompt) expect(prompts[0]).toBe(systemPrompt);
      else expect(prompts[0]).toContain("before the first tool call");
    } finally { await runtime.close(); }
  });
});
