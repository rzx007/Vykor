import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellOutputLogHost } from "@vykor/services/executions";
import { resolveHostShellLauncher, shellJoin } from "@vykor/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { fileReadTool } from "../../file/read.js";
import { grepTool } from "../../search/grep.js";
import { createShellTool } from "../shell.js";
import type { ShellExecutor } from "../types.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function host() {
  const directory = await mkdtemp(join(tmpdir(), "oh-shell-tool-log-"));
  directories.push(directory);
  return { logs: createShellOutputLogHost({ directory }), directory };
}

const text = (result: { content: Array<unknown> }) => (result.content[0] as { text: string }).text;
const reference = (result: { content: Array<unknown> }) =>
  result.content.map((block) => (block as { text?: string }).text ?? "").join("\n").match(/shell-output:\/\/[0-9a-f-]{36}/)?.[0];

describe("foreground Shell log consumption", () => {
  it("recovers a real foreground process through Read and Grep without rerunning it", async () => {
    const { logs, directory } = await host();
    const script = join(directory, "emit.cjs");
    const launches = join(directory, "launches.txt");
    const report = "BEGIN\n" + "甲".repeat(7500) + "\nONLY_MIDDLE_SENTINEL\n" + "乙".repeat(7500) + "\nEND\n";
    await writeFile(script, [
      "const fs = require('node:fs');",
      "fs.appendFileSync(" + JSON.stringify(launches) + ", 'started\\n');",
      "process.stdout.write(" + JSON.stringify(report) + ");",
    ].join("\n"), "utf8");
    const argv = [process.execPath, script];
    const launcher = resolveHostShellLauncher();
    const command = launcher.kind === "powershell"
      ? "& " + argv.map(arg => "'" + arg.replaceAll("'", "''") + "'").join(" ")
      : launcher.kind === "cmd"
        ? '"' + argv.map(arg => '"' + arg + '"').join(" ") + '"'
        : shellJoin(argv);
    const context = {
      cwd: directory, sessionId: "s1", shellOutputLogs: logs,
      settings: { model: "fixture", apiFormat: "openai" as const, maxTurns: 1,
        permission: { mode: "default" as const }, sandbox: { enabled: false } },
    };
    const result = await createShellTool().execute({ command, timeout: 15000 }, context);
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("BEGIN");
    expect(text(result)).toContain("END");
    expect(text(result)).not.toContain("ONLY_MIDDLE_SENTINEL");
    const ref = reference(result)!;
    expect(ref).toMatch(/^shell-output:\/\/[0-9a-f-]{36}$/);
    let cursor = 0;
    let restored = "";
    let eof = false;
    for (let pageIndex = 0; pageIndex < 12; pageIndex++) {
      const page = await fileReadTool.execute({ file_path: ref, cursor }, context);
      expect(page.isError).not.toBe(true);
      const output = text(page);
      restored += output.slice(output.indexOf("\n") + 1);
      const next = Number(output.match(/nextCursor=(\d+)/)?.[1]);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
      if (output.includes("eof=true")) { eof = true; break; }
    }
    expect(eof).toBe(true);
    expect(restored).toBe(report);
    expect(cursor).toBe(Buffer.byteLength(report, "utf8"));
    const found = await grepTool.execute({ path: ref, pattern: "ONLY_MIDDLE_SENTINEL" }, context);
    expect(found.isError).not.toBe(true);
    expect(text(found)).toContain("ONLY_MIDDLE_SENTINEL");
    const denied = await fileReadTool.execute({ file_path: ref }, { ...context, sessionId: "s2" });
    expect(denied.isError).toBe(true);
    expect(await readFile(launches, "utf8")).toBe("started\n");
  }, 20000);

  it.each([
    ["invalid_pattern", "invalid_input", "unknown"],
    ["timeout", "timeout", "unknown"],
    ["search_unavailable", "unknown_outcome", "unknown"],
    ["unavailable", "unknown_outcome", "unknown"],
  ] as const)("classifies Shell log Grep %s without blaming correct arguments", async (status, failureKind, executionState) => {
    const ref = "shell-output://00000000-0000-4000-8000-000000000001";
    const result = await grepTool.execute({ path: ref, pattern: "needle" }, {
      cwd: process.cwd(), sessionId: "owner",
      shellOutputLogs: { search: async () => ({ status, matches: [], truncated: false }) } as any,
    });
    expect(result).toMatchObject({ isError: true, failureKind, executionState });
    expect(result.recoveryHint).toContain(`Read(file_path="${ref}"`);
  });

  it("classifies missing Shell log hosts as unavailable runtime support", async () => {
    const ref = "shell-output://00000000-0000-4000-8000-000000000001";
    const context = { cwd: process.cwd(), sessionId: "owner" };
    const grep = await grepTool.execute({ path: ref, pattern: "needle" }, context);
    const read = await fileReadTool.execute({ file_path: ref }, context);
    expect(grep).toMatchObject({ isError: true, failureKind: "configuration", executionState: "not_started" });
    expect(read).toMatchObject({ isError: true, failureKind: "configuration", executionState: "not_started" });
  });

  it("keeps unavailable Shell log Read distinct from invalid byte cursors", async () => {
    const ref = "shell-output://00000000-0000-4000-8000-000000000001";
    for (const [status, failureKind, executionState] of [
      ["unavailable", "unknown_outcome", "unknown"],
      ["invalid_cursor", "invalid_input", "not_started"],
    ] as const) {
      const result = await fileReadTool.execute({ file_path: ref }, {
        cwd: process.cwd(), sessionId: "owner",
        shellOutputLogs: { read: async () => ({ status }) } as any,
      });
      expect(result).toMatchObject({ isError: true, failureKind, executionState });
    }
  });

  it("retains leading and split UTF-8 BOM characters from both environment streams through Read", async () => {
    const { logs } = await host();
    const stdout = "\uFEFFout\uFEFF" + "x".repeat(13000);
    const stderr = "\uFEFFerr\uFEFF";
    const result = await createShellTool().execute({ command: "inspect" }, {
      cwd: "/work", sessionId: "s1", shellOutputLogs: logs,
      environment: {
        info: { shellDescriptor: { family: "posix", dialect: "posix-sh", executable: "/bin/sh", argsPrefix: [], displayName: "Shell", pathStyle: "posix", tempDir: "/tmp", capabilities: { conditionalAndOr: true, supportsLoginShell: true } } },
        workspace: { executionRoot: "/work" }, paths: { resolve: async () => ({ executionPath: "/work", mountPurpose: "workspace", mountMode: "rw" }) },
        process: { execShell: async () => ({
          onOutput(listener: (chunk: Uint8Array) => void) {
            const bytes = new TextEncoder().encode(stdout);
            listener(bytes.subarray(0, 1));
            listener(bytes.subarray(1, 2));
            listener(bytes.subarray(2));
            return () => {};
          },
          onErrorOutput(listener: (chunk: Uint8Array) => void) {
            const bytes = new TextEncoder().encode(stderr);
            listener(bytes.subarray(0, 2));
            listener(bytes.subarray(2));
            return () => {};
          },
          wait: async () => ({ exitCode: 0 }),
        }) },
      } as any,
    });
    const ref = reference(result)!;
    let cursor = 0;
    let reconstructed = "";
    for (;;) {
      const page = await fileReadTool.execute({ file_path: ref, cursor }, { cwd: "/work", sessionId: "s1", shellOutputLogs: logs });
      expect(page.isError).not.toBe(true);
      const body = text(page);
      reconstructed += body.slice(body.indexOf("\n") + 1);
      cursor = Number(body.match(/nextCursor=(\d+)/)?.[1]);
      if (body.includes("eof=true")) break;
    }
    expect(reconstructed).toBe(stdout + stderr);
    expect(cursor).toBe(Buffer.byteLength(stdout + stderr, "utf8"));
  });

  it("captures the environment stream once and recovers omitted middle through Read and Grep", async () => {
    const { logs } = await host();
    const report = "start\n" + "x".repeat(7000) + "MIDDLE_NEEDLE" + "y".repeat(7000) + "\nend";
    let launches = 0;
    const feedback = await createShellTool().execute({ command: "inspect" }, {
      cwd: "/work", sessionId: "s1", shellOutputLogs: logs,
      environment: {
        info: { shellDescriptor: { family: "posix", dialect: "posix-sh", executable: "/bin/sh", argsPrefix: [], displayName: "Shell", pathStyle: "posix", tempDir: "/tmp", capabilities: { conditionalAndOr: true, supportsLoginShell: true } } },
        workspace: { executionRoot: "/work" }, paths: { resolve: async () => ({ executionPath: "/work", mountPurpose: "workspace", mountMode: "rw" }) },
        process: { execShell: async () => { launches++; return {
          onOutput(listener: (chunk: Uint8Array) => void) { const bytes = new TextEncoder().encode(report); listener(bytes.subarray(0, 7002)); listener(bytes.subarray(7002)); return () => {}; },
          wait: async () => ({ exitCode: 0 }),
        }; } },
      } as any,
    });
    expect(launches).toBe(1);
    expect(text(feedback)).toContain("end");
    expect(text(feedback)).not.toContain("MIDDLE_NEEDLE");
    const ref = reference(feedback)!;
    expect(ref).toMatch(/^shell-output:\/\/[0-9a-f-]{36}$/);
    const found = await grepTool.execute({ pattern: "MIDDLE_NEEDLE", path: ref }, { cwd: "/work", sessionId: "s1", shellOutputLogs: logs });
    expect(text(found)).toContain("MIDDLE_NEEDLE");
    const chunks: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 5; i++) {
      const page = await fileReadTool.execute({ file_path: ref, cursor }, { cwd: "/work", sessionId: "s1", shellOutputLogs: logs });
      const body = text(page);
      chunks.push(body.slice(body.indexOf("\n") + 1));
      const next = body.match(/nextCursor=(\d+)/);
      if (!next) break;
      cursor = Number(next[1]);
    }
    expect(chunks.join("\n")).toContain("MIDDLE_NEEDLE");
    const denied = await fileReadTool.execute({ file_path: ref }, { cwd: "/work", sessionId: "s2", shellOutputLogs: logs });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/unavailable|不可用/i);
  });

  it("keeps short output without creating a log file", async () => {
    const { logs, directory } = await host();
    const result = await createShellTool(legacy("short", false)).execute({ command: "inspect" }, { cwd: process.cwd(), sessionId: "s1", shellOutputLogs: logs });
    expect(text(result)).toBe("short");
    expect(reference(result)).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
    const localFile = join(directory, "notes.txt");
    await writeFile(localFile, "hello");
    const ordinary = await fileReadTool.execute({ file_path: localFile }, { cwd: directory });
    expect(text(ordinary)).toContain("1: hello");
    const invalidCursor = await fileReadTool.execute({ file_path: localFile, cursor: 0 }, { cwd: directory });
    expect(invalidCursor.isError).toBe(true);
    expect(text(invalidCursor)).toContain("offset/limit");
  });

  it("uses the legacy executor stream callback before its bounded result", async () => {
    const { logs } = await host();
    const result = await createShellTool(legacy("a".repeat(7000) + "MIDDLE_NEEDLE" + "z".repeat(7000), true))
      .execute({ command: "inspect" }, { cwd: process.cwd(), sessionId: "s1", shellOutputLogs: logs });
    const ref = reference(result)!;
    expect(ref).toBeDefined();
    const found = await grepTool.execute({ pattern: "MIDDLE_NEEDLE", path: ref }, { cwd: process.cwd(), sessionId: "s1", shellOutputLogs: logs });
    expect(text(found)).toContain("MIDDLE_NEEDLE");
    expect(text(result)).toContain("z".repeat(100));
  });

  it("keeps each Read page within the smallest inline budget and rejects conflicting arguments", async () => {
    const { logs } = await host();
    const capture = logs.begin("s1", 2);
    capture.append("中文".repeat(200));
    const ref = capture.finish(true).reference!;
    const before = process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS;
    process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS = "256";
    try {
      const page = await fileReadTool.execute({ file_path: ref }, { cwd: process.cwd(), sessionId: "s1", shellOutputLogs: logs });
      expect(text(page).length).toBeLessThanOrEqual(256);
      expect(text(page)).toContain("中文");
      expect(text(page)).toMatch(/nextCursor=\d+/);
    } finally {
      if (before === undefined) delete process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS;
      else process.env.VYKOR_TOOL_OUTPUT_INLINE_CHARS = before;
    }
    for (const input of [{ file_path: ref, offset: 1 }, { file_path: ref, limit: 1 }, { file_path: ref, info_only: true }]) {
      const invalid = await fileReadTool.execute(input, { cwd: process.cwd(), sessionId: "s1", shellOutputLogs: logs });
      expect(invalid.isError).toBe(true);
    }
    const badCursor = await fileReadTool.execute({ file_path: ref, cursor: 1 }, { cwd: process.cwd(), sessionId: "s1", shellOutputLogs: logs });
    expect(badCursor.isError).toBe(true);
    const invalidGrep = await grepTool.execute({ pattern: "中", path: ref, include: "*.log" }, { cwd: process.cwd(), sessionId: "s1", shellOutputLogs: logs });
    expect(invalidGrep.isError).toBe(true);
  });

  it("does not invent a complete log from a truncated legacy result", async () => {
    const { logs } = await host();
    const result = await createShellTool(legacy("q".repeat(14000), false))
      .execute({ command: "inspect" }, { cwd: process.cwd(), sessionId: "s1", shellOutputLogs: logs });
    const ref = reference(result);
    expect(ref).toBeDefined();
    const page = await logs.read({ sessionId: "s1", reference: ref! });
    expect(page.status).toBe("ok");
    if (page.status === "ok") expect(page.complete).toBe(false);
  });

  it("retains received output when an environment wait throws, without calling it complete", async () => {
    const { logs } = await host();
    const result = await createShellTool().execute({ command: "inspect" }, {
      cwd: "/work", sessionId: "s1", shellOutputLogs: logs,
      environment: {
        info: { shellDescriptor: { family: "posix", dialect: "posix-sh", executable: "/bin/sh", argsPrefix: [], displayName: "Shell", pathStyle: "posix", tempDir: "/tmp", capabilities: { conditionalAndOr: true, supportsLoginShell: true } } },
        workspace: { executionRoot: "/work" }, paths: { resolve: async () => ({ executionPath: "/work", mountPurpose: "workspace", mountMode: "rw" }) },
        process: { execShell: async () => ({
          onOutput(listener: (chunk: Uint8Array) => void) { listener(new TextEncoder().encode("z".repeat(13000) + "PARTIAL_END")); return () => {}; },
          wait: async () => { throw new Error("wait failed"); },
        }) },
      } as any,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("PARTIAL_END");
    const ref = reference(result)!;
    const page = await logs.read({ sessionId: "s1", reference: ref });
    expect(page.status).toBe("ok");
    if (page.status === "ok") expect(page.complete).toBe(false);
  });

  it("does not launch an already cancelled environment command", async () => {
    const { logs, directory } = await host();
    const controller = new AbortController();
    controller.abort();
    let launches = 0;
    const result = await createShellTool().execute({ command: "inspect" }, {
      cwd: "/work", sessionId: "s1", shellOutputLogs: logs, abortSignal: controller.signal,
      environment: {
        info: { shellDescriptor: { family: "posix", dialect: "posix-sh", executable: "/bin/sh", argsPrefix: [], displayName: "Shell", pathStyle: "posix", tempDir: "/tmp", capabilities: { conditionalAndOr: true, supportsLoginShell: true } } },
        workspace: { executionRoot: "/work" }, paths: { resolve: async () => ({ executionPath: "/work", mountPurpose: "workspace", mountMode: "rw" }) },
        process: { execShell: async () => { launches++; throw new Error("must not launch"); } },
      } as any,
    });
    expect(result.failureKind).toBe("interrupted");
    expect(launches).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });

  it("reports the real byte offset when one regex match spans a long line", async () => {
    const { logs } = await host();
    const capture = logs.begin("s1", 2);
    capture.append("x".repeat(13000));
    const ref = capture.finish(true).reference!;
    const result = await grepTool.execute({ path: ref, pattern: "x+" }, { cwd: process.cwd(), sessionId: "s1", shellOutputLogs: logs });
    const output = text(result);
    expect(output).toMatch(/^0: x+/);
    expect(output).not.toContain("(no matches)");
    expect(output).toContain(`Read(file_path="${ref}", cursor=0)`);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(8192);
  });

  it.each([
    ["中", "中+", 7800],
    ["😀", "😀+", 5000],
    ["👩‍💻", "(?:👩‍💻)+", 1000],
  ])("bounds a long %s regex match in UTF-8 bytes without splitting characters", async (character, pattern, count) => {
    const { logs } = await host();
    const capture = logs.begin("s1", 2);
    capture.append("lead\n" + character.repeat(count));
    const ref = capture.finish(true).reference!;
    const result = await grepTool.execute({ path: ref, pattern }, { cwd: process.cwd(), sessionId: "s1", shellOutputLogs: logs });
    const output = text(result);
    expect(output).toMatch(new RegExp(`^5: ${character}`));
    expect(output).not.toContain("(no matches)");
    expect(output).not.toContain("�");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(8192);
    expect(output).toContain(`Read(file_path="${ref}", cursor=5)`);
    const snippet = output.slice("5: ".length, output.indexOf("\n")).replace(/…$/, "");
    expect(snippet).toMatch(new RegExp(`^(?:${character})+$`, "u"));
  });
});

function legacy(output: string, stream: boolean): ShellExecutor {
  return {
    async resolve(request, context) { return { command: request.command, cwd: context.cwd, timeoutMs: 1000, maxOutputChars: 12000, policy: {} as any, hostShell: { kind: "posix-sh" }, runner: { mode: "host", fallbackToHost: false } }; },
    async run(_spec, _signal, onOutput) {
      if (stream) onOutput?.(output);
      return { status: "completed", output: output.slice(0, 12001), outputTruncated: output.length > 12000, exitCode: 0 };
    },
  };
}
