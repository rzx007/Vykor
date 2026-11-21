import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { StreamingMessageClient, ToolExecutionResult } from "@vykor/agent-contracts";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { SessionStore } from "@vykor/services";
import { DaemonApplication } from "../../../daemon-application.js";

it.each([
  { mode: "repaired", status: "completed", exitCodes: [1, 0], modelCalls: 3 },
  { mode: "still failing", status: "failed", exitCodes: [1, 1], modelCalls: 3 },
  { mode: "no work after failure", status: "failed", exitCodes: [1], modelCalls: 2 },
  { mode: "repair limit reached", status: "failed", exitCodes: [1], modelCalls: 5 },
  { mode: "permission denied", status: "failed", exitCodes: [undefined], modelCalls: 1 },
  { mode: "provider blocked completion", status: "failed", exitCodes: [], modelCalls: 1 },
  { mode: "truncated then passed", status: "completed", exitCodes: [0], modelCalls: 2 },
  { mode: "truncated then failed", status: "failed", exitCodes: [1], modelCalls: 3 },
  { mode: "ordinary prompt", status: "completed", exitCodes: [], modelCalls: 1 },
] as const)("settles a normal chat with $mode", async ({ mode, status, exitCodes, modelCalls }) => {
  const directory = mkdtempSync(join(process.cwd(), ".test-completion-check-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  const reportPath = join(directory, "report.txt");
  writeFileSync(reportPath, mode === "truncated then passed" ? "fixed" : "broken");
  writeFileSync(join(directory, "check.cjs"), `
    if (require("node:fs").readFileSync("report.txt", "utf8") !== "fixed") {
      console.error("Report still broken");
      process.exitCode = 1;
    }
  `);
  const shellResults: ToolExecutionResult[] = [];
  const deliveries: { text: string; checkExitCode: unknown }[] = [];
  const permissionCommands: unknown[] = [];
  let calls = 0;
  let feedback = "";
  let previousReplies: unknown[] = [];
  const client: StreamingMessageClient = { async *streamMessage({ messages }) {
    calls++;
    if (mode === "truncated then passed" && calls === 3) {
      previousReplies = messages.flatMap(message => message.type === "assistant" && message.phase === "final_answer" ? [message.content] : []);
    }
    if (calls === 1 && mode.startsWith("truncated then")) {
      yield { type: "text_delta", phase: "final_answer", delta: "First part. " };
      yield { type: "complete", stopReason: "max_tokens" };
      return;
    }
    if (mode === "repair limit reached" && calls > 1) {
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `read-${calls}`, name: "Read",
        input: { file_path: reportPath } } };
      yield { type: "complete", stopReason: "tool_use" };
      return;
    }
    if (calls === 2) {
      feedback = messages.filter(message => message.type === "tool_result")
        .flatMap(message => message.content.flatMap(block => block.type === "text" ? [block.text] : [])).join("\n");
      if (mode === "repaired" || mode === "still failing") {
        if (mode === "still failing") yield { type: "text_delta", phase: "final_answer", delta: "Premature final answer" };
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "repair", name: "Write",
          input: { file_path: reportPath, content: mode === "repaired" ? "fixed" : "different but broken" } } };
        yield { type: "complete", stopReason: "tool_use" };
        return;
      }
    }
    yield { type: "text_delta", delta: calls === 1 ? "First draft" : "Report updated" };
    yield { type: "complete", stopReason: mode === "provider blocked completion" ? "content_filter" : "end_turn" };
  } };
  const app = new DaemonApplication({ store, log: () => {},
    settings: { model: "offline", apiFormat: "openai", permission: { mode: mode === "permission denied" ? "ask" : "full_access" },
      sandbox: { enabled: false }, plugins: { enabled: false }, memory: { enabled: false, sessionMemoryEnabled: false } },
    createAgent: async ({ options }) => {
      const agent = await createDefaultNodeAgent({ ...options, client,
        capabilityOverrides: { ...options.capabilityOverrides, terminal: false, backgroundShell: false, memory: false },
        effects: { ...options.effects, requestPermission: async request => {
          permissionCommands.push(request.input.command);
          return { status: "denied" };
        } },
        onEvent: async event => {
          if (event.type === "tool.completed" && event.data.result.toolName === "Shell") shellResults.push(event.data.result);
          if (event.type === "output.text.delta") {
            deliveries.push({ text: event.data.delta, checkExitCode: shellResults.at(-1)?.metadata?.exitCode });
          }
          await options.onEvent?.(event);
        },
      });
      return { agent, host: agent.host };
    },
  });
  try {
    await app.ready();
    const session = app.commands.createSession({ cwd: directory, model: "offline" });
    const check = mode === "truncated then passed" ? "验收命令: node check.cjs" : "/check node check.cjs";
    const text = mode === "ordinary prompt" ? `Fix the report\n${check}` : `${check}\nFix the report`;
    const { run } = await app.interactions.admitPrompt(session.id, { items: [{ type: "text", text }] });
    const result = await app.runControl.awaitRun(session.id, run!.id);
    expect(result.status, result.error ?? undefined).toBe(status);
    expect(calls, result.error ?? undefined).toBe(modelCalls);
    expect(shellResults.map(result => result.metadata?.exitCode)).toEqual(exitCodes);
    expect(store.runs.listRuns(session.id)).toHaveLength(1);
    if (status === "failed") expect(deliveries).toEqual([]);
    if (mode === "permission denied") {
      expect(permissionCommands).toEqual(["node check.cjs"]);
      expect(shellResults[0]?.executionState).toBe("not_started");
    }
    if (mode === "repaired") {
      expect(feedback).toContain("Report still broken");
      expect(readFileSync(reportPath, "utf8")).toBe("fixed");
      expect(result.output).toBe("Report updated");
      expect(deliveries.map(delivery => delivery.text).join("")).toBe(result.output);
      expect(deliveries.every(delivery => delivery.checkExitCode === 0)).toBe(true);
    }
    if (mode === "still failing") expect(readFileSync(reportPath, "utf8")).toBe("different but broken");
    if (mode === "truncated then passed") {
      expect(result.output).toBe("First part. Report updated");
      const next = await app.interactions.admitPrompt(session.id, { items: [{ type: "text", text: "Summarize the previous task" }] });
      await app.runControl.awaitRun(session.id, next.run!.id);
      expect(previousReplies).toEqual([result.output]);
    }
    if (mode === "still failing" || mode === "truncated then failed") expect(result.output).toBe("");
  } finally {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
