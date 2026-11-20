import { describe, expect, it, vi } from "vitest";
import * as sandbox from "@vykor/sandbox";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createSessionEnvironmentAcquirer } from "../session-execution-environment.js";

describe("createSessionEnvironmentAcquirer", () => {
  it("preserves the original CLI sandbox when leaving initial full access", async () => {
    const policies: boolean[] = [];
    const create = sandbox.createExecutionEnvironment;
    const spy = vi.spyOn(sandbox, "createExecutionEnvironment").mockImplementation(input => create(input, {
      createShellProcess: async (_command, options) => {
        policies.push(options.settings!.sandbox!.enabled!);
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
        return child as never;
      },
    }));
    try {
      const baseline = { model: "test", permission: { mode: "ask" as const }, sandbox: { enabled: true, network: { mode: "none" as const } } };
      const handle = await createSessionEnvironmentAcquirer({ surface: "cli_advanced", loadSecrets: false })(
        { id: "cli", cwd: process.cwd(), metadata: { runtime: { model: "test", approvalMode: "full_access" } } } as never,
        sandbox.settingsForApprovalMode(baseline, "full_access"),
      );
      await handle.process.execShell("echo full");
      await handle.withFullAccess!(false).process.execShell("echo restricted");
      expect(policies).toEqual([false, true]);
      await handle.release();
    } finally { spy.mockRestore(); }
  });

  it("keeps the background invocation choice even when session metadata differs", async () => {
    const modes: unknown[] = [];
    const create = sandbox.createExecutionEnvironment;
    const spy = vi.spyOn(sandbox, "createExecutionEnvironment").mockImplementation(input => {
      modes.push(input.settings.sandbox?.enabled);
      return create(input);
    });
    try {
      const acquire = createSessionEnvironmentAcquirer({ loadSecrets: false });
      for (const [sessionMode, capturedMode] of [["full_access", "ask"], ["ask", "full_access"]] as const) {
        const baseline = { model: "test", permission: { mode: capturedMode }, sandbox: { enabled: true } };
        const handle = await acquire({ id: "bg", cwd: process.cwd(), metadata: { runtime: { model: "test", approvalMode: sessionMode } } } as never,
          sandbox.settingsForApprovalMode(baseline, capturedMode), { kind: "background", id: "bg" });
        await handle.release();
      }
      expect(modes).toEqual([true, false]);
    } finally { spy.mockRestore(); }
  });

  it("keeps CLI file access native and does not require unrelated Agent secrets", async () => {
    const handle = await createSessionEnvironmentAcquirer({surface:"cli_advanced",loadSecrets:false})(
      {id:"files",cwd:process.cwd(),metadata:{runtime:{model:"test"}}} as any,
      {model:"test",apiFormat:"openai",maxTurns:1,permission:{mode:"default"},
        agentEnvironment:{kind:"wsl",secretEnv:["VYKOR_UNCONFIGURED_FILES_TEST_SECRET"]},sandbox:{enabled:false}},
    );
    expect(handle.info.kind).toBe("local");
    await handle.release();
  });
  it("creates a lightweight local handle without a shared lease", async () => {
    const handle = await createSessionEnvironmentAcquirer()(
      { id: "s1", cwd: process.cwd(), metadata: { runtime: { model: "test" } } } as any,
      {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        agentEnvironment: { kind: "native" },
        sandbox: { enabled: false },
      },
    );
    expect(handle.info.kind).toBe("local");
    expect(handle.workspace).toEqual({ kind: "local", hostRoot: process.cwd(), executionRoot: process.cwd() });
    expect(handle).not.toHaveProperty("leaseId");
    await expect(handle.release()).resolves.toBeUndefined();
  });
});
