# Agent 执行环境第一期实现计划

> 状态：历史计划，Docker 路线已被 [Native / WSL 方案](../specs/2026-09-07-native-wsl-execution-environment-design.md) 取代。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 交付 Desktop 的本机/Docker 运行环境选择，使 Docker 模式下所有仍可调用的 Agent 本地工作负载都在容器中执行，并统一使用 `/workspace` 与 `/opt/vykor/skills`。

**架构：** 新增纯契约包 `@vykor/environment`，由 Sandbox 提供本机和 Docker 的进程、文件、路径与环境事实实现；Agent Runtime 只接收环境句柄。第一期设置变化重启后生效，单个工作区只保留最新配置容器，Docker PTY、共享终端 lease 和运行中热切换留到后续计划。

**技术栈：** TypeScript、Node.js、Electron、React、Docker CLI、Vitest、pnpm workspace、Turborepo

---

## 规格依据

- `docs/superpowers/specs/2026-09-07-agent-runtime-environment-and-terminal-design.md`
- 第一阶段只实现规格第 18.1 节。
- 第二阶段 Docker PTY 与统一终端、第三阶段生命周期恢复分别另写计划。

## 文件结构

### 新建

- `packages/environment/package.json`：环境契约包清单。
- `packages/environment/tsconfig.json`：环境契约包 TypeScript 配置。
- `packages/environment/src/types.ts`：环境、工作区、路径、进程与文件接口。
- `packages/environment/src/index.ts`：环境契约公共导出。
- `packages/environment/src/types.test.ts`：工作区绑定和环境信息的不变量测试。
- `packages/sandbox/src/execution-config.ts`：Desktop/CLI 环境配置解析与校验。
- `packages/sandbox/src/execution-config.test.ts`：surface、优先级和当前配置结构测试。
- `packages/sandbox/src/execution-environment.ts`：Local/Docker 第一阶段环境句柄。
- `packages/sandbox/src/execution-environment.test.ts`：环境创建顺序、信息与 fail-closed 测试。
- `packages/tools/src/file/environment-path.ts`：文件工具的执行路径解析适配。
- `packages/tools/src/file/__test__/environment-path.test.ts`：容器路径、相对路径和越界测试。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-control.tsx`：运行环境设置控件。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-model.ts`：设置页纯状态转换。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-model.test.ts`：local/docker/SRT/restart 状态测试。

### 修改

- `packages/core/src/types/settings.ts`：增加 Terminal 设置。
- `packages/core/src/config/settings.ts`：Terminal 默认值与深合并。
- `packages/core/src/types/tools.ts`：ToolContext 环境能力和工具执行域。
- `packages/core/src/engine/tool-registry.ts`：保留执行域元数据。
- `packages/core/package.json`：增加环境契约依赖。
- `packages/sandbox/src/types.ts`：受管挂载、surface 和环境启动参数。
- `packages/sandbox/src/config.ts`：受管 Desktop 配置归一化。
- `packages/sandbox/src/docker-backend.ts`：统一 `/workspace`、Skills rw 挂载和单版本替换。
- `packages/sandbox/src/lifecycle.ts`：从受管挂载创建环境。
- `packages/sandbox/src/shell.ts`：通过环境进程能力执行。
- `packages/sandbox/src/index.ts`：导出新环境 API。
- `packages/sandbox/src/index.test.ts`：挂载与过期容器替换测试。
- `packages/sandbox/e2e/docker.e2e.test.ts`：真实挂载、路径和单版本测试。
- `packages/tools/src/file/operations.ts`：删除宿主路径到容器路径的工具内转换。
- `packages/tools/src/file/path.ts`：按 execution cwd 解析路径。
- `packages/tools/src/file/sandbox-guard.ts`：改用结构化环境路径。
- `packages/tools/src/file/read.ts`、`write.ts`、`edit.ts`、`glob.ts`、`grep.ts`：消费环境文件能力。
- `packages/tools/src/file/__test__/operations.test.ts`、`read.test.ts`、`edit.test.ts`、`glob.test.ts`：容器路径契约测试。
- `packages/permissions/src/index.ts`：按 execution path 裁决，并携带可选 host path。
- `packages/permissions/src/index.test.ts`：当前 pathRules 路径域与审批路径测试。
- `packages/permissions/package.json`：增加环境契约依赖。
- `packages/prompts/src/index.ts`：接收已经探测的环境信息。
- `packages/prompts/src/index.test.ts`：本机/Docker 环境段测试。
- `packages/agent-runtime/src/agent-options.ts`：接收环境覆盖。
- `packages/agent-runtime/src/agent-composition.ts`：先创建环境，再创建 Prompt 和 Runtime。
- `packages/agent-runtime/src/default-runtime.ts`：删除内部 Sandbox attach，使用环境句柄。
- `packages/agent-runtime/src/default-runtime.test.ts`：初始化顺序、ToolContext 与清理测试。
- `packages/agent-runtime/src/runtime-integrations.ts`：按执行域过滤 Native Plugin Tools。
- `packages/agent-runtime/src/native-tools/activate.ts`：Docker 第一期禁止激活 Native Tool Host。
- `packages/server/src/application/visual-tools/daemon-image-to-text-tool.ts`：路径输入通过环境读取字节。
- `packages/server/src/application/visual-tools/__test__/daemon-image-to-text-tool.test.ts`：禁止宿主任意路径读取。
- `packages/server/package.json`：增加环境契约依赖。
- `packages/tools/src/meta/skill.ts`：Skill file/root 使用环境路径呈现。
- `packages/tools/src/meta/__test__/meta.test.ts`：Skill 路径和 Registry 刷新测试。
- `packages/skills/src/index.ts`：可从不可变基线重建 Registry。
- `packages/skills/src/index.test.ts`：删除、重命名和来源优先级测试。
- `apps/desktop/src/shared/settings-types.ts`：Desktop 环境状态和更新输入。
- `apps/desktop/src/shared/ipc-channels.ts`、`desktop-api-contract.ts`：运行环境设置 IPC。
- `apps/desktop/src/preload/desktop-api.ts`：暴露更新方法。
- `apps/desktop/src/main/features/settings/ipc.ts`、`settings-service.ts`：预检并保存配置。
- `apps/desktop/src/main/features/settings/settings-service.test.ts`：保存、失败和重启提示测试。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`：替换运行环境占位控件。
- `apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx`：第一期 Docker 会话明确显示本机终端限制。
- `packages/server/src/daemon/__test__/daemon-agent.test.ts`：项目外 Docker Runtime 覆盖。
- `docs/sandbox-runtime-flow.md`：更新第一期真实调用链。
- `pnpm-lock.yaml`：记录新增 workspace 包和依赖边。

## 任务 1：建立环境契约包

**文件：**

- 创建：`packages/environment/package.json`
- 创建：`packages/environment/tsconfig.json`
- 创建：`packages/environment/src/types.ts`
- 创建：`packages/environment/src/index.ts`
- 创建：`packages/environment/src/types.test.ts`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：编写 WorkspaceBinding 不变量测试**

```ts
import { describe, expect, it } from "vitest";
import { createWorkspaceBinding } from "./types.js";

describe("createWorkspaceBinding", () => {
  it("keeps host and execution roots separate for Docker", () => {
    expect(createWorkspaceBinding({
      kind: "docker",
      hostRoot: "D:\\code\\vk",
      executionRoot: "/workspace",
    })).toEqual({
      kind: "docker",
      hostRoot: "D:\\code\\vk",
      executionRoot: "/workspace",
    });
  });

  it("rejects a non-POSIX Docker execution root", () => {
    expect(() => createWorkspaceBinding({
      kind: "docker",
      hostRoot: "D:\\code\\vk",
      executionRoot: "D:\\code\\vk",
    })).toThrow("Docker execution root must be an absolute POSIX path");
  });
});
```

- [ ] **步骤 2：运行测试并确认缺少实现**

运行：`pnpm --filter @vykor/environment test`

预期：FAIL，包或 `createWorkspaceBinding` 尚不存在。

- [ ] **步骤 3：创建纯契约包和最小类型**

```ts
export type ExecutionEnvironmentKind = "local" | "docker";
export type ToolExecutionDomain = "environment" | "control_plane";

export interface WorkspaceBinding {
  kind: ExecutionEnvironmentKind;
  hostRoot: string;
  executionRoot: string;
}

export interface ResolvedEnvironmentPath {
  executionPath: string;
  hostPath?: string;
  mountPurpose: "workspace" | "user_skills" | "unmounted";
  mountMode?: "ro" | "rw";
}

export interface EffectiveEnvironmentInfo {
  kind: ExecutionEnvironmentKind;
  hostOs: string;
  executionOs: string;
  shell: string;
  shellDialect: "powershell" | "cmd" | "posix";
  pathStyle: "windows" | "posix";
  cwd: string;
  homeDir: string;
  tempDir: string;
  mounts: Array<{ path: string; mode: "ro" | "rw"; purpose: string }>;
  networkMode: string;
  limitations: string[];
}
```

同时定义不依赖具体实现的 `EnvironmentProcessExecutor`、`EnvironmentFileSystem`、`EnvironmentPathResolver` 和 `ExecutionEnvironmentHandle`。文件能力必须同时支持 `readText()` 与 `readBytes()`，供 ImageToText 使用。

运行 `pnpm install --lockfile-only`，让 workspace lockfile 记录新包。

- [ ] **步骤 4：运行包测试和类型检查**

运行：`pnpm --filter @vykor/environment test && pnpm --filter @vykor/environment check-types`

预期：全部通过。

- [ ] **步骤 5：提交**

```bash
git add packages/environment pnpm-lock.yaml
git commit -m "feat(environment): define execution environment contracts"
```

## 任务 2：实现受管环境配置解析

**文件：**

- 创建：`packages/sandbox/src/execution-config.ts`
- 创建：`packages/sandbox/src/execution-config.test.ts`
- 修改：`packages/core/src/types/settings.ts`
- 修改：`packages/core/src/config/settings.ts`
- 修改：`packages/sandbox/src/index.ts`
- 修改：`packages/sandbox/package.json`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：编写 surface 和配置结构测试**

```ts
it("maps the Desktop Docker choice to fail-closed Docker", () => {
  expect(resolveExecutionEnvironmentConfig({
    surface: "desktop_managed",
    settings: settings({ sandbox: { enabled: true, backend: "docker" } }),
    cwd: "D:\\code\\vk",
  })).toMatchObject({ kind: "docker", failClosed: true });
});

it("rejects SRT and extra mounts on the managed Desktop surface", () => {
  expect(() => resolveExecutionEnvironmentConfig({
    surface: "desktop_managed",
    settings: settings({ sandbox: { enabled: true, backend: "srt" } }),
    cwd: "D:\\code\\vk",
  })).toThrow("Desktop does not support the configured SRT environment");

  expect(() => resolveExecutionEnvironmentConfig({
    surface: "desktop_managed",
    settings: settings({
      sandbox: { enabled: true, backend: "docker", docker: { extraMounts: ["C:\\:/host"] } },
    }),
    cwd: "D:\\code\\vk",
  })).toThrow("Desktop managed Docker does not allow extraMounts");
});

it("keeps advanced CLI SRT configuration valid", () => {
  expect(resolveExecutionEnvironmentConfig({
    surface: "cli_advanced",
    settings: settings({ sandbox: { enabled: true, backend: "srt" } }),
    cwd: "/repo",
  })).toMatchObject({ mode: "legacy_srt", backend: "srt" });
});

it("loads the current schema without a version marker", async () => {
  await expect(loadSettingsFile(fileWith({ sandbox: { enabled: false } })))
    .resolves.toMatchObject({ sandbox: { enabled: false } });
});

it("rejects version markers and deprecated fields", async () => {
  await expect(loadSettingsFile(fileWith({ _formatVersion: 1 })))
    .rejects.toMatchObject({ code: "invalid_settings_field" });
  await expect(loadSettingsFile(fileWith({ sandbox: { runtime: "docker" } })))
    .rejects.toMatchObject({ code: "invalid_settings_field" });
});
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm --filter @vykor/sandbox test -- execution-config.test.ts`

预期：FAIL，解析函数不存在。

- [ ] **步骤 3：实现唯一解析入口**

```ts
export type ExecutionSurface = "desktop_managed" | "cli_advanced";

export function resolveExecutionEnvironmentConfig(input: {
  surface: ExecutionSurface;
  settings: Settings;
  cwd: string;
}): ResolvedExecutionEnvironmentConfig {
  const sandbox = normalizeSandboxConfig(input.settings.sandbox);
  if (input.surface === "desktop_managed") {
    if (sandbox.enabled && sandbox.backend === "srt") {
      throw new ExecutionConfigError("unsupported_srt", "Desktop does not support the configured SRT environment");
    }
    if (sandbox.docker.extraMounts.length > 0) {
      throw new ExecutionConfigError("extra_mounts_forbidden", "Desktop managed Docker does not allow extraMounts");
    }
  }
  return sandbox.enabled && sandbox.backend === "docker"
    ? { kind: "docker", failClosed: true, sandbox }
    : { kind: "local", failClosed: false, sandbox };
}
```

`cli_advanced` 继续返回现有 Sandbox/SRT 策略所需信息，不能被 Desktop 限制误伤。

Settings 加载器不读取或写入版本字段。`_formatVersion`、`sandbox.runtime` 和其他未知字段返回包含配置路径的 `invalid_settings_field`，不自动改写文件。

- [ ] **步骤 4：增加 Terminal 设置并验证深合并**

```ts
export interface TerminalSettings {
  localShell?: string;
  dockerShell?: "/bin/sh" | "/bin/bash";
}

export interface Settings {
  terminal?: TerminalSettings;
}
```

为 `DEFAULT_SETTINGS` 增加 `terminal: { dockerShell: "/bin/sh" }`，并像 Sandbox 一样合并用户、项目、环境变量和 CLI 层，避免浅合并丢失另一个 Shell。`saveSettings` 和 `saveProjectSettings` 只写当前 Settings 字段，不附加版本标记。

- [ ] **步骤 5：运行配置相关测试**

运行：`pnpm --filter @vykor/core test -- settings && pnpm --filter @vykor/sandbox test -- execution-config.test.ts`

预期：全部通过，`ProjectRecord.defaultShell` 仍作为当前项目的本机 Shell。

- [ ] **步骤 6：提交**

```bash
git add packages/core packages/sandbox pnpm-lock.yaml
git commit -m "feat(sandbox): resolve managed execution environment settings"
```

## 任务 3：建立受管挂载与单版本容器

**文件：**

- 修改：`packages/sandbox/src/types.ts`
- 修改：`packages/sandbox/src/config.ts`
- 修改：`packages/sandbox/src/docker-backend.ts`
- 修改：`packages/sandbox/src/lifecycle.ts`
- 修改：`packages/sandbox/src/index.test.ts`
- 修改：`packages/sandbox/e2e/docker.e2e.test.ts`

- [ ] **步骤 1：编写受管挂载参数测试**

```ts
it("mounts only the workspace and user skills on the Desktop surface", () => {
  const argv = buildDockerRunArgs({
    surface: "desktop_managed",
    cwd: "D:\\code\\vk",
    userSkillsRoot: "C:\\Users\\me\\.vykor\\skills",
    config: dockerConfig(),
  });
  expect(argv).toContain("D:\\code\\vk:/workspace");
  expect(argv).toContain("C:\\Users\\me\\.vykor\\skills:/opt/vykor/skills");
  expect(argv.join(" ")).not.toContain("docker.sock");
});

it("uses /workspace on POSIX hosts too", () => {
  expect(toContainerWorkspacePath("/home/me/vk")).toBe("/workspace");
});
```

- [ ] **步骤 2：编写过期容器替换测试**

构造同一 owner、旧 hash 的已验证 VK 容器，断言启动流程按顺序调用 `stop/remove/run`，且没有创建第二个容器名。再构造缺少 owner label 的同名容器，断言返回 `container_owner_conflict` 且没有删除调用。

- [ ] **步骤 3：运行测试并确认现有行为不符**

运行：`pnpm --filter @vykor/sandbox test -- index.test.ts`

预期：FAIL，POSIX 仍使用宿主绝对路径，Skills 尚未挂载，旧容器只报 hash 不匹配。

- [ ] **步骤 4：实现结构化受管挂载**

```ts
export interface ManagedMount {
  purpose: "workspace" | "user_skills";
  source: string;
  target: "/workspace" | "/opt/vykor/skills";
  mode: "rw";
}
```

由 `startSandboxRuntime()` 接收结构化挂载。使用 `getSkillsDir()` 的真实结果并在 Docker 启动前 `mkdir({ recursive: true })`。工作区必须先 `stat()` 并确认为目录。

- [ ] **步骤 5：实现单版本替换**

容器名称只由 workspace owner 生成，hash 只保存到 label。只有名称、owner label 和 VK 管理 label 全部匹配时，才能删除旧容器并按最新配置重建；任何所有权不确定都 fail-closed。

- [ ] **步骤 6：运行 Sandbox 单元测试**

运行：`pnpm --filter @vykor/sandbox test`

预期：全部通过。

- [ ] **步骤 7：运行真实 Docker 定向测试**

运行：`pnpm --filter @vykor/sandbox e2e:docker`

预期：Docker 可用时验证 `/workspace`、Skills rw 和单一容器；Docker 不可用时明确显示 skip 原因，不把 skip 记录为通过证据。

- [ ] **步骤 8：提交**

```bash
git add packages/sandbox
git commit -m "feat(sandbox): manage workspace and skill mounts"
```

## 任务 4：实现第一阶段 ExecutionEnvironment

**文件：**

- 创建：`packages/sandbox/src/execution-environment.ts`
- 创建：`packages/sandbox/src/execution-environment.test.ts`
- 修改：`packages/sandbox/src/shell.ts`
- 修改：`packages/sandbox/src/index.ts`
- 修改：`packages/sandbox/package.json`

- [ ] **步骤 1：编写环境启动和信息测试**

```ts
it("publishes Docker facts only after the runtime is ready", async () => {
  const events: string[] = [];
  const handle = await createExecutionEnvironment({
    config: dockerExecutionConfig(),
    binding: dockerBinding(),
    onEvent: (event) => events.push(event.type),
  });
  expect(events).toEqual(["preflight", "start", "probe", "ready"]);
  expect(handle.info).toMatchObject({
    kind: "docker",
    executionOs: "linux",
    shell: "/bin/sh",
    pathStyle: "posix",
    cwd: "/workspace",
  });
});
```

再增加 Docker 启动失败测试，断言 promise reject，且没有调用 Local executor。

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm --filter @vykor/sandbox test -- execution-environment.test.ts`

预期：FAIL，环境句柄不存在。

- [ ] **步骤 3：实现 Local/Docker 环境句柄**

```ts
export interface CreateExecutionEnvironmentInput {
  config: ResolvedExecutionEnvironmentConfig;
  binding: WorkspaceBinding;
  sessionId: string;
  managedMounts: ManagedMount[];
}

export async function createExecutionEnvironment(
  input: CreateExecutionEnvironmentInput,
): Promise<ExecutionEnvironmentHandle> {
  return input.config.kind === "docker"
    ? await createDockerEnvironment(input)
    : await createLocalEnvironment(input);
}
```

句柄提供 process、files、paths、info 和幂等 `release()`。第一期由一个 Agent Runtime 独占句柄，不实现共享 lease Manager。

- [ ] **步骤 4：让 Shell 只依赖环境进程能力**

`createShellProcess` 和 `createProcess` 保留兼容包装，但新工具路径直接调用 `context.environment.process`。包装层不能在 Docker 失败后退回宿主。

- [ ] **步骤 5：运行测试与类型检查**

运行：`pnpm --filter @vykor/sandbox test && pnpm --filter @vykor/sandbox check-types`

预期：全部通过。

- [ ] **步骤 6：提交**

```bash
git add packages/sandbox
git commit -m "feat(sandbox): expose local and Docker environment handles"
```

## 任务 5：统一文件路径和权限裁决

**文件：**

- 修改：`packages/core/src/types/tools.ts`
- 修改：`packages/core/package.json`
- 创建：`packages/tools/src/file/environment-path.ts`
- 创建：`packages/tools/src/file/__test__/environment-path.test.ts`
- 修改：`packages/tools/src/file/operations.ts`
- 修改：`packages/tools/src/file/path.ts`
- 修改：`packages/tools/src/file/sandbox-guard.ts`
- 修改：`packages/tools/src/file/read.ts`
- 修改：`packages/tools/src/file/write.ts`
- 修改：`packages/tools/src/file/edit.ts`
- 修改：`packages/tools/src/file/glob.ts`
- 修改：`packages/tools/src/search/grep.ts`
- 修改：`packages/tools/package.json`
- 修改：`packages/permissions/src/index.ts`
- 修改：对应文件与 Permission 测试
- 修改：`packages/permissions/package.json`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：编写容器路径测试**

```ts
it("resolves Docker paths in the execution namespace", async () => {
  const resolved = await resolveToolPath("/workspace/src/app.ts", dockerEnvironment());
  expect(resolved).toMatchObject({
    executionPath: "/workspace/src/app.ts",
    hostPath: "D:\\code\\vk\\src\\app.ts",
    mountPurpose: "workspace",
    mountMode: "rw",
  });
});

it("resolves relative paths from /workspace", async () => {
  expect((await resolveToolPath("src/app.ts", dockerEnvironment())).executionPath)
    .toBe("/workspace/src/app.ts");
});

it("rejects traversal and symlink escape", async () => {
  await expect(resolveToolPath("/workspace/link-to-host/secret", dockerEnvironment()))
    .rejects.toThrow("Path escapes the mounted execution roots");
});
```

- [ ] **步骤 2：编写 PermissionChecker 路径域测试**

覆盖相对规则、本机绝对规则、Docker `/workspace` 规则、Docker Skill 根规则和 Docker 中非法的 Windows 绝对规则。非法路径规则必须返回 `invalid_execution_path_rule`，不做宿主到容器的配置迁移。审批结果必须包含 executionPath，hostPath 只能来自真实挂载。

- [ ] **步骤 3：运行测试并确认失败**

运行：`pnpm --filter @vykor/tools test -- environment-path.test.ts && pnpm --filter @vykor/permissions test`

预期：FAIL，现有代码先使用宿主 `node:path`。

- [ ] **步骤 4：给 ToolContext 注入环境能力**

```ts
export interface ToolContext {
  cwd: string; // executionRoot
  environment: ExecutionEnvironmentHandle;
}
```

所有 Runtime 都必须提供 environment。测试和独立工具宿主显式构造 LocalEnvironment，避免每个工具自行判断平台。

- [ ] **步骤 5：改造文件工具**

删除 `DockerFileOperations.containerPath()` 中的宿主路径转换。文件工具先调用 environment.paths.resolve，再调用 environment.files；所有返回路径使用 executionPath。

- [ ] **步骤 6：改造 PermissionChecker 和 diff**

PermissionChecker 接收 `ResolvedEnvironmentPath`。Docker 中规则以 executionPath 裁决；diff 旧内容通过 environment.files 读取。审批 UI 数据同时携带 executionPath 和可选 hostPath。

- [ ] **步骤 7：运行文件和权限测试**

运行：`pnpm --filter @vykor/tools test && pnpm --filter @vykor/permissions test`

预期：全部通过。

- [ ] **步骤 8：提交**

```bash
git add packages/core packages/tools packages/permissions pnpm-lock.yaml
git commit -m "refactor(tools): resolve files through execution environment"
```

## 任务 6：调整 Agent Runtime 创建顺序

**文件：**

- 修改：`packages/agent-runtime/src/agent-options.ts`
- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/agent-runtime/src/default-runtime.test.ts`
- 修改：`packages/prompts/src/index.ts`
- 修改：`packages/prompts/src/index.test.ts`
- 修改：`packages/agent-runtime/package.json`
- 修改：`packages/prompts/package.json`

- [ ] **步骤 1：编写创建顺序测试**

```ts
it("starts the environment before building the model prompt", async () => {
  const order: string[] = [];
  await composeVykorAgent({
    createEnvironment: async () => {
      order.push("environment-ready");
      return fakeDockerEnvironment();
    },
    buildPrompt: async (info) => {
      order.push(`prompt:${info.cwd}`);
      return "prompt";
    },
  }, internals());
  expect(order).toEqual(["environment-ready", "prompt:/workspace"]);
});
```

增加初始化失败测试：Prompt 或 Runtime 构建失败时 environment.release 只调用一次。

- [ ] **步骤 2：编写环境提示词测试**

传入 Docker `EffectiveEnvironmentInfo`，断言输出包含 Linux、`/bin/sh`、`/workspace`、Skills rw 和网络模式，不包含宿主 cwd、完整 PATH 或可执行文件列表。

- [ ] **步骤 3：运行测试并确认失败**

运行：`pnpm --filter @vykor/agent-runtime test -- default-runtime.test.ts && pnpm --filter @vykor/prompts test`

预期：FAIL，现有 Prompt 在 Sandbox attach 前按宿主生成。

- [ ] **步骤 4：重排 composition**

使用 hostRoot 加载设置、发现 Skill 和处理 Git；随后创建环境；再使用 executionRoot 构建 PermissionChecker、Hook、Prompt 和 QueryEngine。

`default-runtime.ts` 删除 `attachSandboxRuntime()`，不再直接 import `startSandboxRuntime`。RuntimeBundle cleanup 只调用注入环境句柄的 `release()`。

- [ ] **步骤 5：改造 Prompt API**

```ts
export async function buildRuntimeSystemPrompt(input: {
  environmentInfo: EffectiveEnvironmentInfo;
  customPrompt?: string;
  permissionMode?: PromptPermissionMode;
  fastMode?: boolean;
  workStyle?: WorkStyle;
  effort?: string;
  passes?: number;
  memoryContent?: string;
  includeDelegation?: boolean;
  includeBackgroundShell?: boolean;
  skillsList?: Array<{ name: string; description: string }>;
}): Promise<string>
```

删除默认路径中对 `getEnvironmentInfo(cwd)` 的再次宿主探测。

- [ ] **步骤 6：第一期禁用 Docker Agent Terminal**

环境为 Docker 时，不把 Terminal capability 注入 QueryEngine，TerminalOpen 不进入工具注册表；本机行为保持不变。

- [ ] **步骤 7：运行 Agent Runtime 与 Prompt 测试**

运行：`pnpm --filter @vykor/agent-runtime test && pnpm --filter @vykor/prompts test`

预期：全部通过。

- [ ] **步骤 8：提交**

```bash
git add packages/agent-runtime packages/prompts
git commit -m "refactor(agent-runtime): bind agents to resolved environments"
```

## 任务 7：强制工具执行域并封闭宿主旁路

**文件：**

- 修改：`packages/core/src/types/tools.ts`
- 修改：`packages/core/src/engine/tool-registry.ts`
- 修改：`packages/tools/src/registry.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/agent-runtime/src/runtime-integrations.ts`
- 修改：`packages/agent-runtime/src/native-tools/activate.ts`
- 修改：`packages/server/src/application/visual-tools/daemon-image-to-text-tool.ts`
- 修改：相关 Core、Agent Runtime 和 ImageToText 测试
- 修改：`packages/server/package.json`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：编写工具域注册测试**

```ts
it("defaults undeclared tools to local-only environment work", () => {
  const tool = defineTool({ name: "plugin-tool", execute: vi.fn() });
  expect(resolveToolExecution(tool)).toEqual({
    domain: "environment",
    supportedEnvironments: ["local"],
  });
});

it("hides local-only environment tools from Docker agents", () => {
  expect(modelVisibleTools(registryWithLocalOnlyTool(), fakeDockerEnvironment()))
    .not.toContain("plugin-tool");
});

it("blocks brokered web tools when the effective network mode is none", () => {
  expect(modelVisibleTools(registryWithWebTools(), fakeDockerEnvironment({ networkMode: "none" })))
    .not.toContain("WebFetch");
});
```

- [ ] **步骤 2：扩展工具定义**

```ts
export interface ToolExecutionSpec {
  domain: "environment" | "control_plane";
  supportedEnvironments?: Array<"local" | "docker">;
}

export interface ToolDefinition {
  execution?: ToolExecutionSpec;
}
```

未声明时解析为 `{ domain: "environment", supportedEnvironments: ["local"] }`。所有内置工具显式分类，避免安全行为依赖名字。

- [ ] **步骤 3：为内置工具登记执行域**

Bash、文件、后台、LSP、MCP stdio 标记 environment/local+docker；Skill、ListSkills、附件 ID、ImageGeneration、MCP HTTP/SSE 和受控 Web 工具标记 control_plane。第一期 Terminal 和 Native Plugin Tool 只支持 local。

WebSearch、WebFetch、ImageToText URL 和远程 MCP 通过统一 control-plane network policy 检查。有效网络模式为 `none` 或权限策略禁止网络时，不注册或拒绝调用；不能因为它们运行在宿主服务就绕过 Docker 会话的网络选择。

- [ ] **步骤 4：禁止 Docker 激活 Native Plugin Tool Host**

在 `configureDiscoveredExtensions`/`activateNativePluginTools` 前检查环境 kind。Docker 时返回明确诊断 `native_tools_unavailable_in_docker`，且不调用 `fork()`。

- [ ] **步骤 5：让 ImageToText 路径走环境字节读取**

```ts
const resolved = await context.environment.paths.resolve(rawPath, "read");
const data = await context.environment.files.readBytes(resolved.executionPath);
```

删除路径输入分支中的宿主 `resolve()` 和 `readFile()`。附件 ID 继续使用宿主 Attachment Service；URL 输入受网络与权限策略控制。

- [ ] **步骤 6：运行旁路安全测试**

运行：`pnpm --filter @vykor/core test && pnpm --filter @vykor/agent-runtime test -- native-tools && pnpm --filter @vykor/server test -- daemon-image-to-text-tool.test.ts`

预期：Docker 场景没有 Native Tool Host fork，ImageToText 路径没有宿主 readFile。

- [ ] **步骤 7：提交**

```bash
git add packages/core packages/tools packages/agent-runtime packages/server pnpm-lock.yaml
git commit -m "feat(runtime): enforce tool execution domains"
```

## 任务 8：统一 Skill 路径和刷新

**文件：**

- 修改：`packages/skills/src/index.ts`
- 修改：`packages/skills/src/index.test.ts`
- 修改：`packages/tools/src/meta/skill.ts`
- 修改：`packages/tools/src/meta/__test__/meta.test.ts`
- 修改：`packages/tools/package.json`

- [ ] **步骤 1：编写 Skill 路径呈现测试**

```ts
it("returns execution-visible Skill file and root paths", async () => {
  const result = await skillTool.execute({ name: "review" }, dockerToolContext());
  expect(textOf(result)).toContain("Skill file: /opt/vykor/skills/review/SKILL.md");
  expect(textOf(result)).toContain("Skill root: /opt/vykor/skills/review");
  expect(textOf(result)).not.toContain("C:\\Users\\");
});
```

同时覆盖项目 Skill → `/workspace/...`、Bundled → `(embedded)`、未挂载 Plugin → `(unavailable in this environment)`。

- [ ] **步骤 2：编写删除和覆盖测试**

先加载 user Skill，删除其目录后刷新，断言 Registry 不再返回旧定义。再创建 bundled/plugin/user/project 同名项，断言 project 胜出。

- [ ] **步骤 3：运行测试并确认失败**

运行：`pnpm --filter @vykor/skills test && pnpm --filter @vykor/tools test -- meta.test.ts`

预期：FAIL，现有刷新复制共享 Registry，路径仍为宿主路径。

- [ ] **步骤 4：从不可变基线重建 Registry**

增加 `createSkillRegistrySnapshot({ bundled, plugins, userDir, projectDirs })`，每次从 bundled/plugin 基线开始，再按 `bundled < plugin < user < project` 扫描。不能复用带旧 filesystem 项的 Map。

- [ ] **步骤 5：通过环境呈现路径**

Skill 工具对 `skill.path` 和 `dirname(skill.path)` 都调用 `context.environment.paths.presentHostPath()`。返回 unavailable 时保留 Markdown 正文，但明确附带资源不可访问。

- [ ] **步骤 6：运行 Skills 和 Tools 测试**

运行：`pnpm --filter @vykor/skills test && pnpm --filter @vykor/tools test`

预期：全部通过。

- [ ] **步骤 7：提交**

```bash
git add packages/skills packages/tools
git commit -m "fix(skills): present paths through execution environment"
```

## 任务 9：接入 Desktop 运行环境设置

**文件：**

- 修改：`apps/desktop/src/shared/settings-types.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`
- 修改：`apps/desktop/src/main/features/settings/ipc.ts`
- 修改：`apps/desktop/src/main/features/settings/settings-service.ts`
- 修改：`apps/desktop/src/main/features/settings/settings-service.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-control.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-model.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/runtime-setting-model.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx`

- [ ] **步骤 1：编写 Desktop Snapshot 测试**

```ts
expect(buildDesktopSettingsSnapshot(settings({ sandbox: { enabled: false } })))
  .toMatchObject({ agentEnvironment: "local", restartRequired: false });

expect(buildDesktopSettingsSnapshot(settings({
  sandbox: { enabled: true, backend: "docker" },
}))).toMatchObject({ agentEnvironment: "docker" });

expect(buildDesktopSettingsSnapshot(settings({
  sandbox: { enabled: true, backend: "srt" },
}))).toMatchObject({ agentEnvironment: "unsupported_srt" });
```

- [ ] **步骤 2：编写设置更新服务测试**

选择 Docker 时断言先调用 Desktop preflight，再写入 `enabled=true/backend=docker/failIfUnavailable=true`。预检失败时断言没有 patchSettings。保存成功返回 `restartRequired=true`。

- [ ] **步骤 3：运行 Desktop 定向测试并确认失败**

运行：`pnpm --filter @vykor/desktop test -- settings-service.test.ts runtime-setting-model.test.ts`

预期：FAIL，新字段和控件不存在。

- [ ] **步骤 4：增加 IPC 和 Service 方法**

```ts
export type DesktopAgentEnvironment = "local" | "docker" | "unsupported_srt";

export interface UpdateDesktopAgentEnvironmentInput {
  environment: "local" | "docker";
}
```

新增 `settingsUpdateAgentEnvironment` IPC。Service 使用 `desktop_managed` preflight，成功后 patch 全局 Settings。

- [ ] **步骤 5：实现设置控件**

替换静态 `SettingSelect`。保存中禁用选择器；错误显示具体 preflight 信息；成功显示“重启后生效”。SRT 状态显示不可支持说明，等待用户明确选择本机或 Docker。

- [ ] **步骤 6：标记第一期终端限制**

Docker 配置下的现有集成终端继续显式创建 `runtime: local`，标题或空状态标明“本机终端”。Agent Terminal 已在任务 6 中从 Docker 工具集移除。

- [ ] **步骤 7：运行 Desktop 测试和类型检查**

运行：`pnpm --filter @vykor/desktop test && pnpm --filter @vykor/desktop typecheck`

预期：全部通过。

- [ ] **步骤 8：提交**

```bash
git add apps/desktop
git commit -m "feat(desktop): configure the default agent environment"
```

## 任务 10：验证项目外会话的第一期能力

**文件：**

- 修改：`apps/desktop/src/main/features/session/outside-project-workspace.test.ts`
- 修改：`packages/server/src/daemon/__test__/daemon-agent.test.ts`
- 修改：`packages/agent-runtime/src/default-runtime.test.ts`

- [ ] **步骤 1：编写项目外 Docker Runtime 测试**

创建没有 projectId、但具有受管 cwd 的 Session，启动 Docker 环境，断言 WorkspaceBinding 为：

```ts
expect(binding).toEqual({
  kind: "docker",
  hostRoot: outsideWorkspace,
  executionRoot: "/workspace",
});
```

- [ ] **步骤 2：编写功能边界测试**

断言项目外 Docker Agent 注册 Shell 和文件工具、不注册 TerminalOpen 和 Native Plugin Tools；Skill root 仍为 `/opt/vykor/skills`。

- [ ] **步骤 3：运行测试并确认失败**

运行：`pnpm --filter @vykor/desktop test -- outside-project-workspace.test.ts && pnpm --filter @vykor/server test -- daemon-agent.test.ts`

预期：至少环境绑定断言失败，随后实现只补通用环境接线，不增加 Projectless 专用 Runtime。

- [ ] **步骤 4：补齐通用接线**

Session 没有 projectId 时使用现有受管 cwd 作为 hostRoot。项目配置层自动跳过，用户全局配置、环境变量和 CLI 覆盖保持有效。

- [ ] **步骤 5：运行项目外和 Agent Runtime 测试**

运行：`pnpm --filter @vykor/desktop test -- outside-project-workspace.test.ts && pnpm --filter @vykor/server test -- daemon-agent.test.ts && pnpm --filter @vykor/agent-runtime test -- default-runtime.test.ts`

预期：全部通过。

- [ ] **步骤 6：提交**

```bash
git add apps/desktop packages/server packages/agent-runtime
git commit -m "test(runtime): cover projectless Docker agents"
```

## 任务 11：第一期集成验证与文档收尾

**文件：**

- 修改：`packages/sandbox/e2e/docker.e2e.test.ts`
- 修改：`packages/tools/e2e/docker-file-tools.e2e.test.ts`
- 修改：`docs/sandbox-runtime-flow.md`
- 修改：`docs/superpowers/specs/2026-09-07-agent-runtime-environment-and-terminal-design.md`

- [ ] **步骤 1：增加真实 Docker 安全闭环测试**

覆盖：

```text
pwd = /workspace
Read/Write/Edit/Glob/Grep 接受容器路径
/workspace 写入同步到宿主工作区
/opt/vykor/skills 写入同步到用户 Skill 根
未挂载宿主目录不可见
同一 owner 只有一个容器名
旧 hash 容器被最新配置替换
Docker 不可用时没有宿主 spawn
```

- [ ] **步骤 2：运行真实 Docker E2E**

运行：`pnpm --filter @vykor/sandbox e2e:docker && pnpm --filter @vykor/tools e2e:docker`

预期：有 Docker daemon 时全部通过；无 Docker 时记录明确 skip，并在交付说明中注明未取得真实 E2E 证据。

- [ ] **步骤 3：更新权威流程文档**

把 `docs/sandbox-runtime-flow.md` 更新为 Environment 创建顺序、两条受管挂载、容器路径文件工具、工具执行域和第一期终端限制。删除“文件工具先使用宿主路径转换”的旧流程。

- [ ] **步骤 4：运行全仓验证**

运行：

```bash
pnpm test
pnpm check-types
pnpm lint
git diff --check
```

预期：全部退出 0。若真实 Docker E2E 因环境缺失被跳过，必须单独列出，不写成通过。

- [ ] **步骤 5：对照规格第 18.1 节逐项勾选**

逐条检查第一期交付项，在规格状态中记录第一期的实际完成和验证结果；第 18.2、18.3 节保持未开始，不为尚未创建的计划添加失效链接。

- [ ] **步骤 6：提交**

```bash
git add packages/sandbox packages/tools docs
git commit -m "test(runtime): verify the managed Docker environment"
```

## 第一阶段完成条件

- Docker 模式下所有仍可见的 environment 工具都获得同一个环境句柄。
- Agent 看到 Linux、`/bin/sh`、`/workspace` 和真实挂载信息。
- 文件工具只接受当前环境路径并在容器中执行。
- 工作区和用户 Skills 是唯一 Desktop 受管 rw 挂载。
- Native Plugin Tools 和 Agent Terminal 在 Docker 第一期不可见。
- ImageToText 路径输入不能读取未挂载宿主文件。
- Docker 不可用时所有环境工作负载 fail-closed。
- 项目外会话不需要 Projectless 专用 Runtime。
- 设置保存后明确要求重启，同一 owner 不存在多版本容器。
- 单元、服务集成、全仓检查通过；真实 Docker E2E 的运行或 skip 状态被准确报告。
