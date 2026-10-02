import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryEngine, ToolRegistry, type Message } from "@vykor/core";
import { createShellOutputLogHost } from "@vykor/services/executions";
import { expect, it } from "vitest";
import { fileReadTool } from "../../file/read.js";
import { createShellTool } from "../shell.js";
import type { ShellExecutor } from "../types.js";

it("reconstructs a long single-line Shell log through repeated engine Read results at the minimum budget", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oh-shell-engine-pages-"));
  const previousInline = process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS;
  const previousPreview = process.env.VYKOR_TOOL_OUTPUT_PREVIEW_CHARS;
  process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS = "256";
  process.env.VYKOR_TOOL_OUTPUT_PREVIEW_CHARS = "128";
  try {
    const original = "a".repeat(12_010) + "中😀MIDDLE_NEEDLE" + "z".repeat(300);
    let launches = 0;
    const executor: ShellExecutor = {
      async resolve(request, context) { return { command: request.command, cwd: context.cwd, timeoutMs: 1000, maxOutputChars: 12000, policy: {} as never, hostShell: { kind: "posix-sh" }, runner: { mode: "host", fallbackToHost: false } }; },
      async run(_spec, _signal, onOutput) {
        launches++;
        onOutput?.(original);
        return { status: "completed", output: original.slice(0, 12001), outputTruncated: true, exitCode: 0 };
      },
    };
    const registry = new ToolRegistry();
    registry.register(createShellTool(executor), { kind: "builtin" });
    registry.register(fileReadTool, { kind: "builtin" });
    const pages: string[] = [];
    const cursors = [0];
    let ref = "";
    let requests = 0;
    const client = { streamMessage: async function* (input: { messages: Message[] }) {
      requests++;
      const result = input.messages.filter((message) => message.type === "tool_result").at(-1);
      const resultText = result?.type === "tool_result"
        ? result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";
      if (requests === 1) {
        yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: "shell", name: "Shell", input: { command: "scripted" } } };
      } else if (!ref) {
        ref = resultText.match(/shell-output:\/\/[0-9a-f-]{36}/)?.[0] ?? "";
        expect(ref).toMatch(/^shell-output:\/\/[0-9a-f-]{36}$/);
        yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: "read-0", name: "Read", input: { file_path: ref, cursor: 0 } } };
      } else {
        expect(result?.type).toBe("tool_result");
        expect(resultText).toMatch(/^Shell output: cursor=/);
        const breakAt = resultText.indexOf("\n");
        pages.push(resultText.slice(breakAt + 1));
        const next = Number(resultText.match(/nextCursor=(\d+)/)?.[1]);
        expect(next).toBeGreaterThan(cursors.at(-1)!);
        cursors.push(next);
        if (!resultText.includes("eof=true")) {
          yield { type: "tool_use_start" as const, toolUse: { type: "tool_use" as const, id: `read-${cursors.length}`, name: "Read", input: { file_path: ref, cursor: next } } };
        }
      }
      yield { type: "complete" as const, stopReason: requests === 1 || (ref && pages.length === 0) || (ref && pages.length > 0 && resultText.includes("eof=false")) ? "tool_use" as const : "end_turn" as const };
    } };
    const engine = new QueryEngine(client, registry, { checkTool: async () => ({ action: "allow" }) } as never,
      { execute: async () => ({ blocked: false }) } as never,
      { cwd: directory, sessionId: "owner", shellOutputLogs: createShellOutputLogHost({ directory }), maxTurns: 300, trajectoryTrackerFactory: false });
    for await (const _ of engine.submitMessage("inspect")) { /* consume */ }
    expect(launches).toBe(1);
    expect(pages.join("")).toBe(original);
    expect(cursors.at(-1)).toBe(Buffer.byteLength(original));
    expect(pages.length).toBeGreaterThan(2);
  } finally {
    if (previousInline === undefined) delete process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS;
    else process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS = previousInline;
    if (previousPreview === undefined) delete process.env.VYKOR_TOOL_OUTPUT_PREVIEW_CHARS;
    else process.env.VYKOR_TOOL_OUTPUT_PREVIEW_CHARS = previousPreview;
    rmSync(directory, { recursive: true, force: true });
  }
});
