import { describe, expect, it } from "vitest";
import { createWslPathResolver } from "@vykor/sandbox";
import { createShellTool } from "../shell.js";

const binding = { kind: "wsl" as const, hostRoot: "D:\\repo", executionRoot: "/mnt/d/repo" };
const descriptor = { family: "posix", dialect: "posix-sh", executable: "/bin/sh", argsPrefix: ["-lc"], displayName: "POSIX Shell",
  pathStyle: "posix", tempDir: "/tmp", capabilities: { conditionalAndOr: true, supportsLoginShell: true } } as const;

function context() {
  const launched: string[] = [];
  const created: any[] = [];
  return { launched, created, value: { cwd: binding.hostRoot, sessionId: "s1", toolCallId: "call",
    environment: { workspace: binding, info: { shellDescriptor: descriptor }, paths: createWslPathResolver(binding),
      process: { async execShell(_command: string, options: { cwd: string }) {
        launched.push(options.cwd);
        return { onOutput(listener: (chunk: Uint8Array) => void) { listener(Buffer.from(options.cwd)); return () => {}; }, wait: async () => ({ exitCode: 0 }) };
      } },
    },
    backgroundShell: { async create(input: unknown) { created.push(input); return { jobId: "job", label: "install" }; } },
  } as any };
}

describe("Shell workdir boundaries", () => {
  it("keeps supervisor ownership at the host workspace and passes a relative WSL subdirectory separately", async () => {
    const ctx = context();
    const result = await createShellTool().execute({ command: "npm install", workdir: "sub" }, ctx.value);
    expect(result).toMatchObject({ executionState: "completed" });
    expect(ctx.created).toEqual([expect.objectContaining({ cwd: "D:\\repo", executionCwd: "/mnt/d/repo/sub", shellDescriptor: descriptor })]);
  });

  it.each(["pwd", "npm install"])("rejects an outside workdir before starting %s", async (command) => {
    const ctx = context();
    const result = await createShellTool().execute({ command, workdir: "../outside" }, ctx.value);
    expect(result).toMatchObject({ isError: true, failureKind: "policy", executionState: "not_started" });
    expect(ctx.launched).toEqual([]);
    expect(ctx.created).toEqual([]);
  });

  it("runs a foreground command in the resolved WSL subdirectory", async () => {
    const ctx = context();
    const result = await createShellTool().execute({ command: "pwd", workdir: "sub" }, ctx.value);
    expect(result.content[0]).toMatchObject({ text: "/mnt/d/repo/sub" });
    expect(ctx.launched).toEqual(["/mnt/d/repo/sub"]);
  });
});
