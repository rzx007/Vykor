# Daemon 启动模式标记与桌面端接管 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让桌面端启动时只复用「桌面托管」的本地 daemon，遇到 CLI daemon 时按 autoStart 设置停进程重启或重协调系统服务；CLI 各入口保持有活 daemon 就复用。

**架构：** registry 增加 `executionSurface` 标记；把守护进程生命周期工具收口到 `@openharness/server/daemon-host`；桌面连接层按标记决策，桌面服务/watchdog 也按标记判定接管；顺带修服务模式缺 `outsideProjectWorkspaceRoot`。

**技术栈：** TypeScript、Vitest、Electron、pnpm/turbo。

**参考规格：** `docs/superpowers/specs/2026-09-19-daemon-surface-coordination-design.md`

---

## 文件结构

- 修改 `packages/server/src/daemon/paths.ts`：`DaemonRegistry` 增加 `executionSurface`，新增 `createDaemonRegistryEntry()`。
- 修改 `packages/server/src/index.ts`、`packages/server/src/daemon-host/index.ts`：导出新符号。
- 新增 `packages/server/src/daemon-host/lifecycle.ts`：`daemonPidAlive`、`terminateDaemonProcess`、`forceKillDaemonProcess`、`waitForProcessExit`、`stopDaemonProcess`。
- 修改 `apps/cli/src/daemon-lifecycle.ts`、`apps/cli/src/commands/daemon.ts`：复用共享工具；registry 写 `cli_advanced`。
- 新增 `apps/desktop/src/main/features/daemon-autostart/daemon-surface.ts`（纯谓词）：`isDesktopManagedRegistry`、`isLoopbackDaemonUrl`。
- 新增 `apps/desktop/src/main/features/daemon-autostart/daemon-takeover.ts`：`stopNonDesktopDaemon`、`reconcileDesktopManagedService`、`waitForDesktopManagedRegistry`。
- 修改 `apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.ts`：新增 `createDesktopDaemonSystemService()`。
- 修改 `apps/desktop/src/main/features/daemon-autostart/daemon-entry.ts`：surface 感知健康检查、接管前停 CLI 进程、补 `outsideProjectWorkspaceRoot`、写 `executionSurface`。
- 修改 `apps/desktop/src/main/features/session/daemon-connection-service.ts`：连接决策。
- 测试：`packages/server/src/daemon/__test__/paths.test.ts`、`packages/server/src/daemon-host/__test__/lifecycle.test.ts`、`apps/desktop/src/main/features/daemon-autostart/daemon-takeover.test.ts`，并扩充既有 `daemon-connection-service.test.ts`、`apps/cli/src/daemon-lifecycle.test.ts`、`daemon-entry.test.ts`。
- 修改文档：`docs/daemon-system-service.md`、`docs/desktop-terminal-pty-design.md`。

---

### 任务 1：registry 记录启动模式

**文件：**
- 修改：`packages/server/src/daemon/paths.ts`
- 修改：`packages/server/src/index.ts:140-148`
- 修改：`packages/server/src/daemon-host/index.ts:12-20`
- 修改：`apps/cli/src/commands/daemon.ts:51-80`
- 测试：`packages/server/src/daemon/__test__/paths.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试**

```ts
// packages/server/src/daemon/__test__/paths.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDaemonRegistryEntry,
  readDaemonRegistry,
  writeDaemonRegistry,
} from "../paths.js";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ohs-registry-")), "registry.json");
}

describe("daemon registry execution surface", () => {
  it("round-trips the execution surface", () => {
    const path = tempPath();
    const entry = createDaemonRegistryEntry({
      url: "http://127.0.0.1:1234",
      pid: 7,
      token: "t",
      storePath: "sessions.db",
      version: "1.0.0",
      executionSurface: "desktop_managed",
      startedAt: 123,
    });
    writeDaemonRegistry(entry, path);
    expect(readDaemonRegistry(path)).toEqual(entry);
  });

  it("tolerates a legacy registry without an execution surface", () => {
    const path = tempPath();
    writeFileSync(
      path,
      JSON.stringify({
        url: "http://127.0.0.1:1234",
        pid: 7,
        token: "t",
        storePath: "sessions.db",
        startedAt: 1,
        version: "1.0.0",
      }),
    );
    expect(readDaemonRegistry(path)?.executionSurface).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/server exec vitest run src/daemon/__test__/paths.test.ts`
预期：FAIL，`createDaemonRegistryEntry is not a function` / 类型报错。

- [ ] **步骤 3：实现 registry 改动**

```ts
// packages/server/src/daemon/paths.ts
export type DaemonExecutionSurface = "desktop_managed" | "cli_advanced";

export interface DaemonRegistry {
  url: string;
  pid: number;
  token: string;
  storePath: string;
  startedAt: number;
  version: string;
  executionSurface?: DaemonExecutionSurface;
}

export function createDaemonRegistryEntry(input: {
  url: string;
  pid: number;
  token: string;
  storePath: string;
  version: string;
  executionSurface: DaemonExecutionSurface;
  startedAt?: number;
}): DaemonRegistry {
  return {
    url: input.url,
    pid: input.pid,
    token: input.token,
    storePath: input.storePath,
    startedAt: input.startedAt ?? Date.now(),
    version: input.version,
    executionSurface: input.executionSurface,
  };
}
```

在 `packages/server/src/index.ts` 的 daemon 导出列表加入 `createDaemonRegistryEntry` 与 `type DaemonExecutionSurface`；在 `packages/server/src/daemon-host/index.ts` 的 registry 导出块同样加入。

- [ ] **步骤 4：CLI 写 `cli_advanced`**

```ts
// apps/cli/src/commands/daemon.ts（runServe 内）
const {
  clearDaemonRegistry,
  createBearerToken,
  createDaemonRegistryEntry,
  readDaemonRegistry,
  startOpenHarnessDaemon,
  writeDaemonRegistry,
} = await import("@openharness/server");
// ...
if (options.register) {
  writeDaemonRegistry(
    createDaemonRegistryEntry({
      url: listen.url,
      pid: process.pid,
      token,
      storePath: server.store.path,
      version: VERSION,
      executionSurface: "cli_advanced",
    }),
  );
}
```

- [ ] **步骤 5：运行测试与类型检查**

运行：`pnpm --filter @openharness/server exec vitest run src/daemon/__test__/paths.test.ts`
预期：PASS。
运行：`pnpm --filter @openharness/server check-types`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add packages/server/src/daemon/paths.ts packages/server/src/daemon/__test__/paths.test.ts packages/server/src/index.ts packages/server/src/daemon-host/index.ts apps/cli/src/commands/daemon.ts
git commit -m "feat(daemon): record execution surface in registry"
```

---

### 任务 2：共享守护进程生命周期工具

**文件：**
- 新建：`packages/server/src/daemon-host/lifecycle.ts`
- 修改：`packages/server/src/daemon-host/index.ts`
- 修改：`apps/cli/src/daemon-lifecycle.ts`
- 修改：`apps/cli/src/commands/daemon.ts`
- 测试：`packages/server/src/daemon-host/__test__/lifecycle.test.ts`（新建）、`apps/cli/src/daemon-lifecycle.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// packages/server/src/daemon-host/__test__/lifecycle.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { daemonPidAlive, stopDaemonProcess } from "../lifecycle.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("daemon lifecycle", () => {
  it("treats EPERM as a live process", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    expect(daemonPidAlive(42)).toBe(true);
  });

  it("returns false when the process is gone", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("no such process");
    });
    expect(daemonPidAlive(42)).toBe(false);
  });

  it("throws when the process survives SIGTERM and force kill", async () => {
    vi.spyOn(process, "kill").mockReturnValue(true);
    await expect(
      stopDaemonProcess(42, { graceMs: 20, forceKillMs: 20 }),
    ).rejects.toThrow(/did not stop/i);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/server exec vitest run src/daemon-host/__test__/lifecycle.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现共享工具**

```ts
// packages/server/src/daemon-host/lifecycle.ts

/** 进程存活判断：能发信号或 EPERM 都算存活（EPERM 表示进程存在但无权发信号）。 */
export function daemonPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function terminateDaemonProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function forceKillDaemonProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs = 5_000,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && daemonPidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !daemonPidAlive(pid);
}

/** SIGTERM → 等待 graceMs → 强制结束 → 等待 forceKillMs；仍存活则抛错。 */
export async function stopDaemonProcess(
  pid: number,
  options: { graceMs?: number; forceKillMs?: number } = {},
): Promise<void> {
  if (!daemonPidAlive(pid)) return;
  terminateDaemonProcess(pid);
  if (await waitForProcessExit(pid, options.graceMs ?? 5_000)) return;
  forceKillDaemonProcess(pid);
  if (await waitForProcessExit(pid, options.forceKillMs ?? 2_000)) return;
  throw new Error(`Daemon process did not stop: ${pid}`);
}
```

在 `packages/server/src/daemon-host/index.ts` 导出这五个函数。

- [ ] **步骤 4：CLI 改用共享实现**

```ts
// apps/cli/src/daemon-lifecycle.ts（顶部替换本地定义）
import { daemonPidAlive, terminateDaemonProcess } from "@openharness/server/daemon-host";

export { daemonPidAlive, terminateDaemonProcess };
```

保留 `probeDaemonRegistry` 主体不变（其默认 `pidAlive` 现在来自共享实现）。删除本地 `daemonPidAlive`、`terminateDaemonProcess` 定义。

`commands/daemon.ts` 里所有「`terminateDaemonProcess(pid)` + `await waitForProcessExit(pid)`」的配对（`start`/`install`/`uninstall`/`stop`/`watchdog`）改为调用会抛错的共享 `stopDaemonProcess(pid)`（SIGTERM → 5 秒 → 强制结束 → 仍存活抛错），保持原「没退干净就中止、不启动第二个 daemon」的语义：

```ts
// apps/cli/src/commands/daemon.ts
import { stopDaemonProcess } from "@openharness/server/daemon-host";
// 删除文件末尾本地 waitForProcessExit（约 428-434 行），
// 并把成对的 terminateDaemonProcess(pid) + await waitForProcessExit(pid) 替换为：
//   await stopDaemonProcess(pid);
```

- [ ] **步骤 5：补 EPERM 回归测试**

在 `apps/cli/src/daemon-lifecycle.test.ts` 追加：

```ts
import { vi } from "vitest";

it("treats an EPERM pid as alive and still probes /health", async () => {
  const spy = vi.spyOn(process, "kill").mockImplementation(() => {
    const error = new Error("not permitted") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  });
  const status = await probeDaemonRegistry(registry(), {
    fetch: async () => response({ ok: true, version: "0.1.0" }),
    expectedVersion: "0.1.0",
  });
  expect(status).toBe("ready");
  spy.mockRestore();
});
```

- [ ] **步骤 6：运行测试与类型检查**

运行：`pnpm --filter @openharness/server exec vitest run src/daemon-host/__test__/lifecycle.test.ts`
运行：`pnpm --filter @rzx/ohs exec vitest run src/daemon-lifecycle.test.ts`
运行：`pnpm --filter @openharness/server check-types; pnpm --filter @rzx/ohs check-types`
预期：全部 PASS。

- [ ] **步骤 7：Commit**

```bash
git add packages/server/src/daemon-host apps/cli/src/daemon-lifecycle.ts apps/cli/src/daemon-lifecycle.test.ts apps/cli/src/commands/daemon.ts
git commit -m "refactor(daemon): share process lifecycle helpers"
```

---

### 任务 3：桌面接管工具与桌面系统服务工厂

**文件：**
- 修改：`apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.ts`
- 新建：`apps/desktop/src/main/features/daemon-autostart/daemon-surface.ts`（纯谓词，无副作用）
- 新建：`apps/desktop/src/main/features/daemon-autostart/daemon-takeover.ts`
- 测试：`apps/desktop/src/main/features/daemon-autostart/daemon-takeover.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试**

```ts
// apps/desktop/src/main/features/daemon-autostart/daemon-takeover.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => ({
  readDaemonRegistry: vi.fn(),
  clearDaemonRegistry: vi.fn(),
  stopDaemonProcess: vi.fn(async () => undefined),
}))

vi.mock("electron", () => ({ app: { isPackaged: true } }))
vi.mock("@openharness/server/daemon-host", () => host)

import {
  isDesktopManagedRegistry,
  isLoopbackDaemonUrl,
} from "./daemon-surface"
import {
  stopNonDesktopDaemon,
  waitForDesktopManagedRegistry,
} from "./daemon-takeover"

function registry(overrides: Record<string, unknown> = {}) {
  return {
    url: "http://127.0.0.1:5555",
    pid: 42,
    token: "tok",
    storePath: "db",
    startedAt: 1,
    version: "1.0.0",
    executionSurface: "cli_advanced",
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe("daemon takeover helpers", () => {
  it("recognizes only desktop-managed registries", () => {
    expect(isDesktopManagedRegistry(registry())).toBe(false)
    expect(isDesktopManagedRegistry(registry({ executionSurface: "desktop_managed" }))).toBe(true)
    expect(isDesktopManagedRegistry({ executionSurface: undefined })).toBe(false)
  })

  it("recognizes loopback urls", () => {
    expect(isLoopbackDaemonUrl("http://127.0.0.1:1")).toBe(true)
    expect(isLoopbackDaemonUrl("http://localhost:1")).toBe(true)
    expect(isLoopbackDaemonUrl("http://10.0.0.5:1")).toBe(false)
  })

  it("refuses to stop a non-loopback daemon", async () => {
    await expect(stopNonDesktopDaemon(registry({ url: "http://10.0.0.5:1" }))).rejects.toThrow(/loopback/i)
    expect(host.stopDaemonProcess).not.toHaveBeenCalled()
  })

  it("stops and clears the registry entry for a loopback daemon", async () => {
    await stopNonDesktopDaemon(registry())
    expect(host.stopDaemonProcess).toHaveBeenCalledWith(42)
    expect(host.clearDaemonRegistry).toHaveBeenCalledOnce()
  })

  it("waits for a healthy desktop-managed registry", async () => {
    host.readDaemonRegistry.mockReturnValue(registry({ executionSurface: "desktop_managed" }))
    const found = await waitForDesktopManagedRegistry({
      isHealthy: async () => true,
      timeoutMs: 500,
    })
    expect(found.pid).toBe(42)
  })

  it("times out when no desktop-managed registry appears", async () => {
    host.readDaemonRegistry.mockReturnValue(registry())
    await expect(
      waitForDesktopManagedRegistry({ isHealthy: async () => true, timeoutMs: 50 }),
    ).rejects.toThrow(/did not become ready/i)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/daemon-autostart/daemon-takeover.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 `createDesktopDaemonSystemService()`**

```ts
// apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.ts
import {
  createDaemonAutoStartController,
  DaemonSystemService,
  type DaemonAutoStartController,
} from "@openharness/server/daemon-host"
// ...
export function createDesktopDaemonSystemService(): DaemonSystemService {
  const flag = process.platform === "win32" ? "--daemon-watchdog" : "--daemon-service"
  const args = app.isPackaged ? [flag] : [app.getAppPath(), flag]
  return new DaemonSystemService({
    invocation: { command: process.execPath, args, cwd: dirname(process.execPath) },
  })
}

export function createDesktopDaemonAutoStartController(): DaemonAutoStartController {
  return createDaemonAutoStartController({
    invocation: createDesktopDaemonSystemService().invocation(),
  })
}
```

- [ ] **步骤 4：实现 `daemon-surface.ts` 与 `daemon-takeover.ts`**

```ts
// apps/desktop/src/main/features/daemon-autostart/daemon-surface.ts
import type { DaemonRegistry } from "@openharness/server/daemon-host"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

export function isDesktopManagedRegistry(
  registry: Pick<DaemonRegistry, "executionSurface">,
): boolean {
  return registry.executionSurface === "desktop_managed"
}

export function isLoopbackDaemonUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}
```

```ts
// apps/desktop/src/main/features/daemon-autostart/daemon-takeover.ts
import type { DaemonRegistry } from "@openharness/server/daemon-host"
import {
  clearDaemonRegistry,
  readDaemonRegistry,
  stopDaemonProcess,
} from "@openharness/server/daemon-host"

import { createDesktopDaemonSystemService } from "./daemon-autostart-service"
import { isDesktopManagedRegistry, isLoopbackDaemonUrl } from "./daemon-surface"

export async function stopNonDesktopDaemon(registry: DaemonRegistry): Promise<void> {
  if (!isLoopbackDaemonUrl(registry.url)) {
    throw new Error(`Refusing to stop a non-loopback daemon at ${registry.url}`)
  }
  await stopDaemonProcess(registry.pid)
  clearDaemonRegistry()
}

export interface DesktopServiceReconciler {
  uninstall(): void
  install(): void
}

export async function reconcileDesktopManagedService(
  registry: DaemonRegistry,
  service: DesktopServiceReconciler = createDesktopDaemonSystemService(),
): Promise<void> {
  service.uninstall()
  if (isLoopbackDaemonUrl(registry.url)) {
    await stopDaemonProcess(registry.pid)
  }
  clearDaemonRegistry()
  service.install()
  await waitForDesktopManagedRegistry()
}

export async function waitForDesktopManagedRegistry(
  options: {
    timeoutMs?: number
    readRegistry?: () => DaemonRegistry | undefined
    isHealthy?: (registry: DaemonRegistry) => Promise<boolean>
  } = {},
): Promise<DaemonRegistry> {
  const readRegistry = options.readRegistry ?? readDaemonRegistry
  const isHealthy = options.isHealthy ?? defaultRegistryHealthy
  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    const registry = readRegistry()
    if (registry && isDesktopManagedRegistry(registry) && (await isHealthy(registry))) {
      return registry
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("The desktop-managed daemon did not become ready within 15 seconds")
}

async function defaultRegistryHealthy(registry: DaemonRegistry): Promise<boolean> {
  try {
    const response = await fetch(`${registry.url.replace(/\/+$/, "")}/health`, {
      headers: { authorization: `Bearer ${registry.token}` },
      signal: AbortSignal.timeout(1_500),
    })
    return response.ok
  } catch {
    return false
  }
}
```

- [ ] **步骤 5：运行测试与类型检查**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/daemon-autostart/`
预期：PASS（含既有 autostart 测试）。
运行：`pnpm --filter @openharness/desktop typecheck:node`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/main/features/daemon-autostart/
git commit -m "feat(desktop): add daemon takeover helpers"
```

---

### 任务 4：桌面连接决策（只复用桌面托管 daemon）

**文件：**
- 修改：`apps/desktop/src/main/features/session/daemon-connection-service.ts`
- 测试：`apps/desktop/src/main/features/session/daemon-connection-service.test.ts`

- [ ] **步骤 1：更新测试 fixture 并编写失败用例**

把既有 `registry()` fixture 改成支持覆盖，默认桌面托管：

```ts
function registry(overrides: Partial<DaemonRegistry> = {}): DaemonRegistry {
  return {
    url: "http://127.0.0.1:5555",
    pid: 4242,
    token: "tok",
    storePath: "D:/db",
    startedAt: 1,
    version: "1.0.0",
    executionSurface: "desktop_managed",
    ...overrides,
  }
}
```

新增用例：

```ts
vi.mock("../daemon-autostart/daemon-surface", () => ({
  isDesktopManagedRegistry: (r: { executionSurface?: string }) =>
    r.executionSurface === "desktop_managed",
}))
vi.mock("../daemon-autostart/daemon-takeover", () => ({
  stopNonDesktopDaemon: vi.fn(async () => undefined),
  reconcileDesktopManagedService: vi.fn(async () => undefined),
}))

// 给文件顶部的 daemonHost mock 补两个导出（整体替换模块，未列出的是 undefined）
// const daemonHost = vi.hoisted(() => ({
//   readDaemonRegistry: vi.fn(),
//   writeDaemonRegistry: vi.fn(),
//   clearDaemonRegistry: vi.fn(),
//   createBearerToken: vi.fn(() => "token"),
//   createDaemonRegistryEntry: vi.fn((input: unknown) => input),
//   startOpenHarnessDaemon: vi.fn(),
//   shouldStartManagedDaemon: vi.fn(async () => false),
// }))

it("reuses a desktop-managed healthy daemon", async () => {
  daemonHost.readDaemonRegistry.mockReturnValue(registry())
  const service = new DaemonConnectionService({ pidAlive: () => true })
  await expect(service.getClient()).resolves.toBeDefined()
  expect(daemonHost.startOpenHarnessDaemon).not.toHaveBeenCalled()
})

it("restarts an ephemeral CLI daemon when autoStart is off", async () => {
  daemonHost.readDaemonRegistry.mockReturnValue(registry({ executionSurface: "cli_advanced" }))
  daemonHost.startOpenHarnessDaemon.mockResolvedValue(embedded)
  const stop = vi.fn(async () => undefined)
  const service = new DaemonConnectionService({
    pidAlive: () => true,
    shouldAutoStart: async () => false,
    stopNonDesktopDaemon: stop,
  })
  await expect(service.getClient()).resolves.toBeDefined()
  expect(stop).toHaveBeenCalledOnce()
  expect(daemonHost.startOpenHarnessDaemon).toHaveBeenCalledOnce()
  expect(daemonHost.writeDaemonRegistry).toHaveBeenCalledWith(
    expect.objectContaining({ executionSurface: "desktop_managed" }),
  )
})

it("reconciles the OS service when autoStart is on", async () => {
  const reconcile = vi.fn(async () => undefined)
  daemonHost.readDaemonRegistry
    .mockReturnValueOnce(registry({ executionSurface: "cli_advanced" }))
    .mockReturnValue(registry())
  const service = new DaemonConnectionService({
    pidAlive: () => true,
    shouldAutoStart: async () => true,
    reconcileDesktopService: reconcile,
  })
  await expect(service.getClient()).resolves.toBeDefined()
  expect(reconcile).toHaveBeenCalledOnce()
  expect(daemonHost.startOpenHarnessDaemon).not.toHaveBeenCalled()
})
```

> 既有用例 "connects to a healthy registered daemon without starting an embedded one" 依赖 fixture 默认值，改成桌面托管后仍成立；"reclaims the registry ... process is dead" 与 "keeps the registry ... still alive" 走校验失败分支，不受影响。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/session/daemon-connection-service.test.ts`
预期：FAIL（新选项不存在 / 非桌面托管走了旧分支）。

- [ ] **步骤 3：实现连接决策**

```ts
// daemon-connection-service.ts（新增 import 与选项）
import { isDesktopManagedRegistry } from "../daemon-autostart/daemon-surface"
import {
  reconcileDesktopManagedService,
  stopNonDesktopDaemon,
} from "../daemon-autostart/daemon-takeover"
import {
  clearDaemonRegistry,
  createBearerToken,
  createDaemonRegistryEntry,
  readDaemonRegistry,
  shouldStartManagedDaemon,
  startOpenHarnessDaemon,
  writeDaemonRegistry,
  type DaemonRegistry,
} from "@openharness/server/daemon-host"

export interface DaemonConnectionServiceOptions {
  pidAlive?: (pid: number) => boolean
  verifyTimeoutMs?: number
  shouldAutoStart?: () => Promise<boolean>
  stopNonDesktopDaemon?: (registry: DaemonRegistry) => Promise<void>
  reconcileDesktopService?: (registry: DaemonRegistry) => Promise<void>
}
```

构造器保存三个注入项：

```ts
this.shouldAutoStart = options.shouldAutoStart ?? (async () => await shouldStartManagedDaemon())
this.stopNonDesktopDaemon = options.stopNonDesktopDaemon ?? stopNonDesktopDaemon
this.reconcileDesktopService = options.reconcileDesktopService ?? reconcileDesktopManagedService
```

`connect()` 结构改为：只在 try/catch 里做校验，接管放在 catch 之后。

```ts
private async connect(): Promise<OpenHarnessClient> {
  let registry: DaemonRegistry | undefined
  try {
    this.setDaemonStatus("discovering", "正在查找 daemon")
    registry = readDaemonRegistry()
  } catch (error) {
    console.warn("[session] daemon registry is unreadable, starting embedded daemon", error)
    registry = undefined
  }

  let verified: OpenHarnessClient | undefined
  if (registry) {
    try {
      this.setDaemonStatus("connecting", "正在连接已运行的 daemon", { url: registry.url })
      const client = new OpenHarnessClient({ baseUrl: registry.url, token: registry.token })
      await this.verifyDaemon(client)
      verified = client
    } catch (error) {
      const detail = errorMessage(error)
      if (this.pidAlive(registry.pid)) {
        this.setDaemonStatus("error", "已注册的 daemon 暂时不可达，请稍后重试", { url: registry.url, detail })
        throw new Error(`Registered daemon (pid ${registry.pid}) is unreachable: ${detail}`)
      }
      console.warn("[session] registered daemon process is gone, starting embedded daemon", error)
      this.setDaemonStatus("starting", "已注册 daemon 已退出，正在启动内置 daemon", { detail })
      clearDaemonRegistry()
    }
  }

  if (verified && registry) {
    if (isDesktopManagedRegistry(registry)) {
      this.setDaemonStatus("ready", "daemon 已连接", { url: registry.url })
      return verified
    }
    return await this.takeOverNonDesktopDaemon(registry)
  }

  return await this.startEmbeddedDaemon()
}

private async takeOverNonDesktopDaemon(registry: DaemonRegistry): Promise<OpenHarnessClient> {
  try {
    if (await this.shouldAutoStart()) {
      this.setDaemonStatus("starting", "正在将 daemon 切换为桌面托管服务", { url: registry.url })
      await this.reconcileDesktopService(registry)
      const next = readDaemonRegistry()
      if (!next || !isDesktopManagedRegistry(next)) {
        throw new Error("Desktop-managed daemon was not registered after service reconciliation")
      }
      this.setDaemonStatus("ready", "daemon 已连接", { url: next.url })
      return new OpenHarnessClient({ baseUrl: next.url, token: next.token })
    }
    this.setDaemonStatus("starting", "正在重启为桌面托管 daemon", { url: registry.url })
    await this.stopNonDesktopDaemon(registry)
    return await this.startEmbeddedDaemon()
  } catch (error) {
    this.setDaemonStatus("error", "daemon 桌面接管失败", {
      url: registry.url,
      detail: errorMessage(error),
    })
    throw error
  }
}
```

新增三个 private 字段声明：

```ts
private readonly shouldAutoStart: () => Promise<boolean>
private readonly stopNonDesktopDaemon: (registry: DaemonRegistry) => Promise<void>
private readonly reconcileDesktopService: (registry: DaemonRegistry) => Promise<void>
```

`startEmbeddedDaemon()` 的 `writeDaemonRegistry` 改为 `createDaemonRegistryEntry({ ..., executionSurface: "desktop_managed" })`（其余字段不变），并保留 `executionSurface: "desktop_managed"` 传给 `startOpenHarnessDaemon`。

- [ ] **步骤 4：运行测试与类型检查**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/session/daemon-connection-service.test.ts`
预期：PASS。
运行：`pnpm --filter @openharness/desktop typecheck:node`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/main/features/session/daemon-connection-service.ts apps/desktop/src/main/features/session/daemon-connection-service.test.ts
git commit -m "feat(desktop): only reuse desktop-managed daemons"
```

---

### 任务 5：桌面服务/watchdog 接管判定与 outside root 修复

**文件：**
- 修改：`apps/desktop/src/main/features/daemon-autostart/daemon-entry.ts`
- 测试：`apps/desktop/src/main/features/daemon-autostart/daemon-entry.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// apps/desktop/src/main/features/daemon-autostart/daemon-entry.test.ts（追加）
import type { DaemonRegistry } from "@openharness/server/daemon-host"

import { registeredDaemonHealthy } from "./daemon-entry"

it("treats a cli_advanced registry as not adoptable", async () => {
  const registry: DaemonRegistry = {
    url: "http://127.0.0.1:1",
    pid: 1,
    token: "t",
    storePath: "db",
    startedAt: 1,
    version: "1.0.0",
    executionSurface: "cli_advanced",
  }
  const healthy = await registeredDaemonHealthy(
    () => registry,
    async () => new Response("{}", { status: 200 }),
  )
  expect(healthy).toBe(false)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/daemon-autostart/daemon-entry.test.ts`
预期：FAIL，`registeredDaemonHealthy` 未导出或未按 surface 判断。

- [ ] **步骤 3：实现 daemon-entry 改动**

```ts
// daemon-entry.ts
import type { DaemonRegistry } from "@openharness/server/daemon-host"
import { stopDaemonProcess } from "@openharness/server/daemon-host"
import { isDesktopManagedRegistry, isLoopbackDaemonUrl } from "./daemon-surface"
import { buildOutsideProjectRoot } from "../session/outside-project-workspace"

export async function registeredDaemonHealthy(
  readRegistry: () => DaemonRegistry | undefined = readDaemonRegistry,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const registry = readRegistry()
  if (!registry || !isDesktopManagedRegistry(registry)) return false
  try {
    const response = await fetchImpl(`${registry.url}/health`, {
      headers: { authorization: `Bearer ${registry.token}` },
      signal: AbortSignal.timeout(1_500),
    })
    return response.ok
  } catch {
    return false
  }
}
```

服务模式（`mode === "service"`）在启动前，若注册表指向存活的非桌面托管 daemon，先停掉它：

```ts
const stale = readDaemonRegistry()
if (stale && !isDesktopManagedRegistry(stale) && isLoopbackDaemonUrl(stale.url)) {
  await stopDaemonProcess(stale.pid).catch((error) => {
    console.warn("[daemon] failed to stop non-desktop daemon", error)
  })
}
clearDaemonRegistry()
```

`startOpenHarnessDaemon` 增加 `outsideProjectWorkspaceRoot: buildOutsideProjectRoot(app.getPath("documents"))`；`writeDaemonRegistry` 改用 `createDaemonRegistryEntry({ ..., executionSurface: "desktop_managed" })`。

- [ ] **步骤 4：运行测试与类型检查**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/daemon-autostart/daemon-entry.test.ts`
预期：PASS。
运行：`pnpm --filter @openharness/desktop typecheck:node`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/main/features/daemon-autostart/daemon-entry.ts apps/desktop/src/main/features/daemon-autostart/daemon-entry.test.ts
git commit -m "feat(desktop): surface-aware daemon service takeover"
```

---

### 任务 6：更新文档

**文件：**
- 修改：`docs/daemon-system-service.md`
- 修改：`docs/desktop-terminal-pty-design.md`

- [ ] **步骤 1：更新 `docs/daemon-system-service.md`**

在「TUI 自动连接时怎么处理」之后新增一节「启动模式与桌面接管」，说明：

- registry 记录 `executionSurface`；
- CLI 入口复用任意 ready daemon；
- 桌面只复用 `desktop_managed`，否则按 `daemon.autoStart` 停进程重启或重协调服务；
- autoStart 开启时系统服务会切换为桌面入口（Windows `--daemon-watchdog`，macOS/Linux `--daemon-service`）。

- [ ] **步骤 2：更新 `docs/desktop-terminal-pty-design.md`**

在「运行环境」一节补充：`environment` 终端要求连接的 daemon 以 `desktop_managed` 启动；桌面启动时会把非桌面托管的本地 daemon 切换为桌面托管，否则环境终端不可用。

- [ ] **步骤 3：Commit**

```bash
git add docs/daemon-system-service.md docs/desktop-terminal-pty-design.md
git commit -m "docs: document daemon execution surface coordination"
```

