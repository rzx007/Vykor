import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostPathToWslPath, preflightWsl, spawnWslProcess } from "../src/index.js";
import { createExecutionEnvironment } from "../src/execution-environment.js";
import { createWorkspaceBinding } from "../../environment/src/index.js";
import { createEnvironmentFileSystem } from "../../tools/src/file/operations.js";
import { DetachedProcessSupervisor } from "../../services/src/executions/detached-process-supervisor.js";
import { SandboxStdioClientTransport } from "../../mcp/src/sandbox-stdio-transport.js";
import { LocalTerminalProvider } from "../../terminal-node/src/local-terminal-provider.js";

const maybeDescribe = process.platform === "win32" ? describe : describe.skip;

maybeDescribe("WSL execution environment e2e", () => {
  it("keeps cwd, env, exit codes, and files inside WSL", async (context) => {
    try {
      await preflightWsl();
    } catch (error) {
      context.skip(error instanceof Error ? error.message : String(error));
      return;
    }

    const hostRoot = await mkdtemp(join(tmpdir(), "vk wsl e2e "));
    const executionRoot = hostPathToWslPath(hostRoot);
    try {
      const success = spawnWslProcess({
        argv: ["/bin/sh", "-lc", "printf '%s|%s' \"$PWD\" \"$VK_WSL_VALUE\"; printf payload > result.txt"],
        cwd: executionRoot,
        env: { VK_WSL_VALUE: "works" },
      });
      const output = await collect(success);
      expect(output.code).toBe(0);
      expect(output.stdout).toBe(`${executionRoot}|works`);
      expect(await readFile(join(hostRoot, "result.txt"), "utf8")).toBe("payload");

      const failed = spawnWslProcess({ argv: ["/bin/sh", "-c", "exit 7"], cwd: executionRoot });
      expect((await collect(failed)).code).toBe(7);
    } finally {
      await rm(hostRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("interrupts a long-running WSL process through AbortSignal", async (context) => {
    try {
      await preflightWsl();
    } catch (error) {
      context.skip(error instanceof Error ? error.message : String(error));
      return;
    }
    const controller = new AbortController();
    const marker = `vk-wsl-abort-${Date.now()}`;
    const child = spawnWslProcess({
      argv: ["/bin/sh", "-c", `exec -a ${marker} sleep 30`],
      cwd: hostPathToWslPath(process.cwd()),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const startedAt = Date.now();
    controller.abort();
    const aborted = await collect(child).catch((error) => ({ code: -1, stdout: String(error) }));
    expect(aborted.code).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const probe = spawnWslProcess({
      argv: ["/usr/bin/pgrep", "-f", marker],
      cwd: hostPathToWslPath(process.cwd()),
    });
    expect((await collect(probe)).code).toBe(1);
  }, 10_000);

  it("runs file search and a detached background shell through WSL", async (context) => {
    if (!(await requireWsl(context))) return;
    const hostRoot = await mkdtemp(join(tmpdir(), "vk wsl tools "));
    const tasksRoot = await mkdtemp(join(tmpdir(), "vk wsl tasks "));
    const executionRoot = hostPathToWslPath(hostRoot);
    const handle = await wslHandle(hostRoot);
    const environment = { ...handle, files: createEnvironmentFileSystem(handle) };
    const supervisor = new DetachedProcessSupervisor(tasksRoot);
    try {
      await mkdir(join(hostRoot, "src"));
      await writeFile(join(hostRoot, "src", "a.ts"), "const marker = 'wsl-needle';\n", "utf8");
      await expect(environment.files.glob(executionRoot, "**/*.ts", 10)).resolves.toEqual(["src/a.ts"]);
      await expect(environment.files.readText(`${executionRoot}/src/a.ts`))
        .resolves.toBe("const marker = 'wsl-needle';\n");
      expect(await environment.files.grep(executionRoot, "wsl-needle", { caseSensitive: true, limit: 10 }))
        .toEqual(["src/a.ts:1:const marker = 'wsl-needle';"]);

      const task = await supervisor.startShellExecution({
        command: "printf background-wsl",
        description: "wsl background",
        cwd: executionRoot,
        processExecutor: environment.process,
      });
      await waitUntil(() => supervisor.getExecution(task.id)?.status === "completed");
      expect(supervisor.readOutput(task.id)).toContain("background-wsl");
    } finally {
      await supervisor.aclose();
      await environment.release();
      await Promise.all([rm(hostRoot, { recursive: true, force: true }), rm(tasksRoot, { recursive: true, force: true })]);
    }
  }, 30_000);

  it("runs stdio MCP and a real PTY in WSL", async (context) => {
    if (!(await requireWsl(context))) return;
    const hostRoot = await mkdtemp(join(tmpdir(), "vk wsl terminal "));
    const handle = await wslHandle(hostRoot);
    const transport = new SandboxStdioClientTransport({
      command: "/bin/cat",
      cwd: handle.workspace.executionRoot,
      processExecutor: handle.process,
    });
    const provider = new LocalTerminalProvider({
      resolveCwd: async () => hostRoot,
      resolveTarget: async (_input, _cwd, id) => handle.terminal.prepare({ cols: 90, rows: 28, owner: { kind: "terminal", id } }),
    });
    try {
      await transport.start();
      const message = new Promise<unknown>((resolve) => { transport.onmessage = resolve; });
      await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
      await expect(message).resolves.toMatchObject({ id: 1, method: "ping" });

      const terminal = await provider.create({
        scope: { kind: "session", sessionId: "wsl-e2e" }, runtime: "environment", cols: 90, rows: 28,
      });
      await provider.resize({ terminalId: terminal.id, cols: 100, rows: 32 });
      await provider.write({ terminalId: terminal.id, data: "printf pty-wsl; exit\r" });
      const finished = await provider.wait({ terminalId: terminal.id, timeoutMs: 10_000 });
      expect(finished.terminal.status).toBe("completed");
      expect(finished.data).toContain("pty-wsl");

      const interrupted = await provider.create({
        scope: { kind: "session", sessionId: "wsl-e2e-interrupt" }, runtime: "environment", cols: 90, rows: 28,
      });
      await provider.write({ terminalId: interrupted.id, data: "sleep 30\r" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await provider.signal({ terminalId: interrupted.id, signal: "interrupt" });
      await provider.write({ terminalId: interrupted.id, data: "printf after-interrupt; exit\r" });
      const afterInterrupt = await provider.wait({ terminalId: interrupted.id, timeoutMs: 10_000 });
      expect(afterInterrupt.data).toContain("after-interrupt");
    } finally {
      await transport.close();
      await provider.dispose();
      await handle.release();
      await rm(hostRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

async function requireWsl(context: { skip(reason?: string): void }): Promise<boolean> {
  try { await preflightWsl(); return true; }
  catch (error) { context.skip(error instanceof Error ? error.message : String(error)); return false; }
}

async function wslHandle(hostRoot: string) {
  const executionRoot = hostPathToWslPath(hostRoot);
  return await createExecutionEnvironment({
    config: { mode: "wsl", kind: "wsl", failClosed: true, cwd: hostRoot, sandbox: { enabled: false, backend: "srt", failIfUnavailable: false, enabledPlatforms: [], filesystem: { allowRead: ["."], denyRead: [], allowWrite: ["."], denyWrite: [], extraAllowedRoots: [] }, network: { mode: "none", allowedDomains: [], deniedDomains: [], strictDomainPolicy: false }, srt: { runtimeCommand: "srt" } } },
    settings: { model: "test", apiFormat: "openai", maxTurns: 1, permission: { mode: "default" }, agentEnvironment: { kind: "wsl" }, sandbox: { enabled: false } },
    binding: createWorkspaceBinding({ kind: "wsl", hostRoot, executionRoot }), sessionId: "wsl-e2e", userSkillsRoot: hostRoot,
  });
}

async function waitUntil(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function collect(child: ReturnType<typeof spawnWslProcess>): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin?.end();
  });
}
