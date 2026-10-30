import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRequestConfigurationSnapshot, Settings } from "@vykor/host-config";
import type { ReplyStyle, StreamingMessageClient } from "@vykor/agent-contracts";
import { createVykorRuntime } from "../default-runtime.js";
import { createDefaultNodeAgent } from "../../agent/default-agent.js";
import { deriveChildAgentOptions } from "../../children/child-agent-options.js";
import { createMemoryRequestConfigurationStore } from "../../configuration/request-configuration.js";

describe("reply preferences in actual model requests", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "vykor-reply-runtime-")); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });
  const settings: Settings = { model: "test", apiFormat: "openai", permission: { mode: "default" }, sandbox: { enabled: false }, replyStyle: "direct" };
  const capture = (prompts: string[]): StreamingMessageClient => ({
    async *streamMessage(input) {
      prompts.push(String(input.system));
      yield { type: "text_delta", delta: "finished" };
      yield { type: "complete", stopReason: "end_turn" };
    },
  });

  it("uses an explicit agent preference over the global default", async () => {
    const prompts: string[] = [];
    const runtime = await createVykorRuntime({ cwd, settings, configuration: { replyStyle: "explanatory", client: capture(prompts) } });
    try {
      for await (const _ of runtime.queryEngine.submitMessage("explain")) { /* consume */ }
      expect(prompts[0].match(/# Reply Style: (\w+)/g)).toEqual(["# Reply Style: Explanatory"]);
    } finally { await runtime.close(); }
  });

  it("replaces the style on the next model request while retaining the notification mode", async () => {
    const prompts: string[] = [];
    let snapshot: AgentRequestConfigurationSnapshot = { revision: 0, configuration: { model: "test", replyStyle: "direct", workStyle: "efficient" } };
    const runtime = await createVykorRuntime({ cwd, settings, configuration: { client: capture(prompts) }, requestConfigurationStore: { read: async () => snapshot } });
    try {
      for await (const _ of runtime.queryEngine.submitMessage("first")) { /* consume */ }
      snapshot = { revision: 1, configuration: { model: "test", replyStyle: "collaborative", workStyle: "efficient" } };
      for await (const _ of runtime.queryEngine.submitMessage("second")) { /* consume */ }
      expect(prompts.map(prompt => prompt.match(/# Reply Style: (\w+)/g))).toEqual([["# Reply Style: Direct"], ["# Reply Style: Collaborative"]]);
      expect(prompts.every(prompt => prompt.includes("# Work Style: Efficient"))).toBe(true);
    } finally { await runtime.close(); }
  });

  it("preserves a complete system prompt exactly even when a style is selected", async () => {
    const prompts: string[] = [];
    const runtime = await createVykorRuntime({ cwd, settings, configuration: { replyStyle: "explanatory", systemPrompt: "Exact host instructions.", client: capture(prompts) } });
    try {
      for await (const _ of runtime.queryEngine.submitMessage("first")) { /* consume */ }
      expect(prompts).toEqual(["Exact host instructions."]);
    } finally { await runtime.close(); }
  });

  it("lets the programmatic agent change style without recreating the session", async () => {
    const prompts: string[] = [];
    const agent = await createDefaultNodeAgent({ cwd, settings, replyStyle: "explanatory", client: capture(prompts), internalTextOnly: true });
    try {
      await agent.runMessage("first");
      expect((await agent.host.configuration.getSnapshot()).configuration.replyStyle).toBe("explanatory");
      await agent.host.configuration.updateConfiguration({ replyStyle: "collaborative" });
      await agent.runMessage("second");
      expect(prompts.map(prompt => prompt.match(/# Reply Style: (\w+)/g))).toEqual([["# Reply Style: Explanatory"], ["# Reply Style: Collaborative"]]);
    } finally { await agent.close(); }
  });

  it("rejects an invalid live preference without committing a new revision", async () => {
    const store = createMemoryRequestConfigurationStore({ model: "test", replyStyle: "direct" }, async next => next);
    await expect(store.update({ replyStyle: "friendly" } as never)).rejects.toThrow(/replyStyle/);
    expect(await store.read()).toEqual({ revision: 0, configuration: { model: "test", replyStyle: "direct" } });
  });

  it("exposes the effective default when programmatic settings omit the preference", async () => {
    const { replyStyle: _style, ...legacySettings } = settings;
    const prompts: string[] = [];
    const agent = await createDefaultNodeAgent({ cwd, settings: legacySettings, client: capture(prompts), internalTextOnly: true });
    try {
      expect((await agent.host.configuration.getSnapshot()).configuration.replyStyle).toBe("collaborative");
      await agent.runMessage("first");
      expect(prompts[0].match(/# Reply Style: (\w+)/g)).toEqual(["# Reply Style: Collaborative"]);
    } finally { await agent.close(); }
  });

  it.each([
    { parent: "direct", child: undefined, expected: "direct" },
    { parent: "direct", child: "explanatory", expected: "explanatory" },
    { parent: undefined, child: undefined, expected: "direct" },
  ] as Array<{ parent: ReplyStyle | undefined; child: ReplyStyle | undefined; expected: ReplyStyle }>)("isolates a child preference from its parent: $expected", ({ parent, child, expected }) => {
    const derived = deriveChildAgentOptions({
      configuration: { replyStyle: parent }, settings,
      child: { description: "inspect", prompt: "inspect", agent: "worker", cwd, replyStyle: child },
      cwd, sessionId: "child",
    });
    expect(derived.replyStyle).toBe(expected);
    expect(settings.replyStyle).toBe("direct");
  });
});
