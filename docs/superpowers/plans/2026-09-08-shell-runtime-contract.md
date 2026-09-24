# Shell 运行时契约实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 以 Execution Environment 为 Shell 唯一事实来源，将模型可见的 `Bash` 直接替换为 `Shell`，让 Windows PowerShell、macOS/Linux POSIX 和 WSL 命令生成、执行、恢复与展示使用同一契约。

**架构：** `ExecutionEnvironmentHandle.info.shellDescriptor` 在会话启动时产生且保持不变。前台 `Shell`、`BackgroundShellCreate`、Hook 命令和 Workflow Shell 命令共用其执行参数；Prompt 和工具说明根据 descriptor 动态生成。Shell 层返回客观进程事实，Query Engine 仅在同一 run 内收敛完全相同的失败调用。

**技术栈：** TypeScript、Node.js child_process、Vitest、React/Electron、SQLite 会话投影。

**规格：** `docs/superpowers/specs/2026-09-08-shell-runtime-contract-design.md`

---

## 文件结构

- 创建 `packages/environment/src/shell-descriptor.ts`：定义 ShellDescriptor、ShellResultMetadata 和类型守卫。
- 修改 `packages/environment/src/types.ts` 与 `index.ts`：让 EffectiveEnvironmentInfo 暴露 descriptor。
- 修改 `packages/sandbox/src/shell.ts`：实现候选选择、可执行验证、版本/能力探测和 argv 组装。
- 修改 `packages/sandbox/src/execution-environment.ts`：Local/WSL 创建时固化 descriptor，process adapter 使用它。
- 创建 `packages/tools/src/shell/shell.ts`：动态创建唯一 `Shell` 工具并返回结构化结果。
- 删除 `packages/tools/src/shell/bash.ts`：不保留可调用别名。
- 修改 `packages/tools/src/registry.ts` 和 `packages/tools/src/background-shell/background-shell-tools.ts`：根据 descriptor 创建前后台工具。
- 创建 `packages/core/src/tools/tool-name-migration.ts`：迁移 Vykor 自有配置中的 `Bash`→`Shell`。
- 修改 Prompt、Permissions、Hooks、Coordinator、Agent Runtime、Server 和 Plugin 名称消费者。
- 修改 `packages/core/src/engine/query-engine.ts`：在现有 repeated failed call guard 上增加 run-scoped evidence revision。
- 修改 Session Transcript 和 Desktop message model：持久化新 metadata，只在读取层兼容历史 `Bash`。
- 创建 `packages/tools/src/shell/__fixtures__/` 和 `trace-eval.test.ts`：保存 34/17 离线轨迹 fixture 与可重复的评测器，不为单一评测新增 workspace package。

### 任务 1：建立可执行的 ShellDescriptor

**文件：**
- 创建：`packages/environment/src/shell-descriptor.ts`
- 修改：`packages/environment/src/types.ts`
- 修改：`packages/environment/src/index.ts`
- 测试：`packages/environment/src/types.test.ts`

- [ ] **步骤 1：编写失败的契约测试**

```ts
import { describe, expect, it } from "vitest";
import { shellArgv, type ShellDescriptor } from "./shell-descriptor.js";

it("keeps executable and launch arguments separate", () => {
  const shell: ShellDescriptor = {
    family: "powershell", dialect: "windows-powershell",
    executable: "powershell.exe",
    argsPrefix: ["-NoLogo", "-NoProfile", "-Command"],
    displayName: "Windows PowerShell 5.1", version: "5.1",
    pathStyle: "windows", tempDir: "C:\\Temp",
    capabilities: { conditionalAndOr: false, supportsLoginShell: false },
  };
  expect(shellArgv(shell, "Get-Location")).toEqual([
    "powershell.exe", "-NoLogo", "-NoProfile", "-Command", "Get-Location",
  ]);
});
```

- [ ] **步骤 2：运行契约测试并确认正确失败**

运行：`pnpm --filter @vykor/environment test -- src/types.test.ts`
预期：FAIL，`shell-descriptor.js` 尚不存在。

- [ ] **步骤 3：实现最小契约**

```ts
export interface ShellDescriptor {
  family: "powershell" | "cmd" | "posix";
  dialect: "windows-powershell" | "pwsh" | "cmd" | "bash" | "posix-sh" | "zsh";
  executable: string;
  argsPrefix: string[];
  displayName: string;
  version?: string;
  pathStyle: "windows" | "posix";
  tempDir: string;
  capabilities: { conditionalAndOr: boolean; supportsLoginShell: boolean };
}

export interface ShellResultMetadata {
  shellFamily: ShellDescriptor["family"];
  shellDialect: ShellDescriptor["dialect"];
  shellExecutable: string;
  shellDisplayName: string;
  pathStyle: ShellDescriptor["pathStyle"];
  exitCode: number | null;
  status: "completed" | "failed" | "timed_out" | "interrupted";
}

export const shellArgv = (shell: ShellDescriptor, command: string): string[] =>
  [shell.executable, ...shell.argsPrefix, command];
```

- [ ] **步骤 4：让 EffectiveEnvironmentInfo 引用唯一 descriptor**

```ts
export interface EffectiveEnvironmentInfo {
  // 保留 OS/cwd/mount/network 字段
  shellDescriptor: ShellDescriptor;
}
```

删除新代码对顶层 `shell`/`shellDialect`/`pathStyle` 的写入；历史会话 metadata 兼容不在本类型中处理。

- [ ] **步骤 5：运行测试和类型检查**

运行：`pnpm --filter @vykor/environment test && pnpm --filter @vykor/environment check-types`
预期：PASS。

- [ ] **步骤 6：提交**

```powershell
git add packages/environment/src
git commit -m "feat(environment): define shell runtime contract"
```

### 任务 2：在 Execution Environment 启动时确定 Shell

**文件：**
- 修改：`packages/sandbox/src/shell.ts`
- 修改：`packages/sandbox/src/execution-environment.ts`
- 修改：`packages/sandbox/src/index.ts`
- 测试：`packages/sandbox/src/execution-environment.test.ts`
- 测试：`packages/sandbox/src/wsl-environment.test.ts`
- 测试：`packages/sandbox/src/index.test.ts`

- [ ] **步骤 1：编写 Windows 候选顺序与不静默回落测试**

```ts
it("prefers a validated pwsh before Windows PowerShell and cmd", async () => {
  const shell = await resolveShellDescriptor({
    platform: "win32", tempDir: "C:\\Temp",
    probe: async (bin) => bin === "pwsh.exe" ? { version: "7.6.0" } : null,
  });
  expect(shell.dialect).toBe("pwsh");
});

it("fails an explicit unusable shell instead of silently falling back", async () => {
  await expect(resolveShellDescriptor({
    platform: "win32", configuredExecutable: "X:\\missing\\pwsh.exe",
    tempDir: "C:\\Temp", probe: async () => null,
  })).rejects.toThrow(/configured shell is unavailable/i);
});
```

- [ ] **步骤 2：运行测试确认现状优先 bash.exe 而失败**

运行：`pnpm --filter @vykor/sandbox test -- src/execution-environment.test.ts`
预期：FAIL，解析器未实现且旧顺序为 bash→powershell→cmd。

- [ ] **步骤 3：实现可注入的探测器**

```ts
export async function resolveShellDescriptor(input: {
  platform: NodeJS.Platform;
  tempDir: string;
  configuredExecutable?: string;
  probe: (executable: string) => Promise<{ version: string } | null>;
}): Promise<ShellDescriptor>;
```

Windows 未配置时只按 `pwsh.exe`→`powershell.exe`→`cmd.exe` 探测。POSIX 优先已确认的用户 Shell，否则 `/bin/sh`。首期不自动选择 Windows Git Bash/fish。

- [ ] **步骤 4：Local/WSL process adapter 只使用 descriptor argv**

```ts
const argv = shellArgv(handle.info.shellDescriptor, command);
return adaptChildProcess(await createProcess(argv, options));
```

WSL descriptor 明确为 `/bin/sh` + `-lc`，不从 Windows 宿主重新探测。

- [ ] **步骤 5：增加 PowerShell cmdlet/native 中文输出测试**

将 process adapter 的 stdout/stderr 保留为字节边界，分别测试 PowerShell pipeline 和 native child process；预期文本均为 `中文测试`，不出现替换字符。

- [ ] **步骤 6：运行 sandbox/environment 测试**

运行：`pnpm --filter @vykor/sandbox test && pnpm --filter @vykor/sandbox check-types`
预期：PASS。

- [ ] **步骤 7：提交**

```powershell
git add packages/sandbox packages/environment
git commit -m "feat(sandbox): resolve one shell per execution environment"
```

### 任务 3：用动态 Shell 工具取代 Bash

**文件：**
- 创建：`packages/tools/src/shell/shell.ts`
- 修改：`packages/tools/src/shell/index.ts`
- 删除：`packages/tools/src/shell/bash.ts`
- 重命名：`packages/tools/src/shell/__test__/bash-tool.test.ts` → `shell-tool.test.ts`
- 重命名：`packages/tools/src/shell/bash.test.ts` → `shell-description.test.ts`
- 修改：`packages/tools/src/registry.ts`
- 修改：`packages/tools/src/index.ts`
- 测试：`packages/tools/src/__test__/registry.test.ts`

- [ ] **步骤 1：先撤销未提交的方言正则扩展**

仅撤销本任务前一轮在 `bash.ts`、Shell 测试、Desktop message model 和 transcript projection 中添加的过渡方案。不使用 `git checkout --` 覆盖用户变更；按当前 diff 用 `apply_patch` 精确删除那些新增段落。

- [ ] **步骤 2：编写工具名和动态说明的失败测试**

```ts
const tool = createShellTool(powerShell51Descriptor, fakeExecutor);
expect(tool.name).toBe("Shell");
expect(tool.description).toContain("Windows PowerShell 5.1");
expect(tool.description).toContain("ConvertFrom-Json");
expect(tool.description).not.toContain("may be bash");
expect(createDefaultToolRegistry({ environment })).not.toHaveProperty("Bash");
```

- [ ] **步骤 3：运行测试确认因只存在 Bash 而失败**

运行：`pnpm --filter @vykor/tools test -- src/shell src/__test__/registry.test.ts`
预期：FAIL，工具名仍为 `Bash`。

- [ ] **步骤 4：实现 createShellDescription 和 createShellTool**

```ts
export function createShellTool(
  shell: ShellDescriptor,
  executor: EnvironmentProcessExecutor,
): ToolDefinition {
  return {
    name: "Shell",
    description: createShellDescription(shell),
    inputSchema: shellInputSchema,
    async execute(input, context) { /* workdir→exec→structured result */ },
  };
}
```

PowerShell 5.1 说明明确 `curl.exe`、`Get-Content -Raw -LiteralPath`、`ConvertFrom-Json`，禁止 heredoc 和多行 `python -c`；PowerShell 7 另外说明支持 `&&`/`||`；POSIX/cmd 使用各自原生说明。

- [ ] **步骤 5：统一结果为 ShellResultMetadata**

```ts
return {
  content: [{ type: "text", text: formattedOutput }],
  isError: exitCode !== 0,
  failureKind: exitCode === 0 ? undefined : "command",
  metadata: shellResultMetadata(shell, exitCode, status),
};
```

高置信方言拒绝不新增状态，统一为 `status: "failed"` + `exitCode: null` + `failureKind: "command"`。只保留少量确定无法解析的防御，不扩展成方言翻译矩阵。

- [ ] **步骤 6：Registry 改为在有 environment 后创建工具**

```ts
export function createDefaultToolRegistry(options: {
  environment: ExecutionEnvironmentHandle;
  // existing capability flags
}): ToolRegistry {
  registerBuiltin(createShellTool(options.environment.info.shellDescriptor, options.environment.process), environment());
}
```

- [ ] **步骤 7：运行 tools 全量测试和类型检查**

运行：`pnpm --filter @vykor/tools test && pnpm --filter @vykor/tools check-types`
预期：PASS，registry 中只有 `Shell`。

- [ ] **步骤 8：提交**

```powershell
git add packages/tools
git commit -m "refactor(tools): replace Bash with environment-bound Shell"
```

### 任务 4：让后台命令共用同一 Shell

**文件：**
- 修改：`packages/tools/src/background-shell/background-shell-tools.ts`
- 修改：`packages/tools/src/background-shell/index.ts`
- 修改：`packages/core/src/types/tools.ts`
- 修改：`packages/server/src/jobs/daemon-job-service.ts`
- 测试：`packages/tools/src/background-shell/__test__/background-shell-create.test.ts`
- 测试：`packages/server/src/jobs/daemon-job-service.test.ts`

- [ ] **步骤 1：编写后台 Shell 同源失败测试**

```ts
const tool = createBackgroundShellTool(powerShell51Descriptor);
await tool.execute({ description: "serve", command: "npm run dev" }, context);
expect(context.backgroundShell.create).toHaveBeenCalledWith(
  expect.objectContaining({ shellDescriptor: powerShell51Descriptor }),
);
expect(tool.description).toContain("Windows PowerShell 5.1");
```

- [ ] **步骤 2：运行测试并确认 request 缺少 descriptor**

运行：`pnpm --filter @vykor/tools test -- src/background-shell`
预期：FAIL，当前 request 只携带 command/cwd/settings。

- [ ] **步骤 3：扩展 AgentBackgroundShellHost 请求契约**

```ts
interface AgentBackgroundShellCreateRequest {
  command: string;
  cwd: string;
  shellDescriptor: ShellDescriptor;
  // existing identity/settings fields
}
```

Daemon Job Service 用 `shellArgv(request.shellDescriptor, request.command)` 启动，不再调用全局 Shell 发现。Hook/Workflow 经由 EnvironmentProcessExecutor 执行的命令也不得跳过 descriptor。

- [ ] **步骤 4：运行 tools/server 测试和类型检查**

运行：`pnpm --filter @vykor/tools test && pnpm --filter @vykor/server test && pnpm --filter @vykor/server check-types`
预期：PASS。

- [ ] **步骤 5：提交**

```powershell
git add packages/tools packages/core packages/server
git commit -m "refactor(jobs): bind background commands to session shell"
```

### 任务 5：完成 Bash→Shell 名称和配置迁移

**文件：**
- 创建：`packages/core/src/tools/tool-name-migration.ts`
- 修改：`packages/core/src/config/settings.ts`
- 修改：`packages/permissions/src/index.ts`
- 修改：`packages/hooks/src/index.ts`
- 修改：`packages/plugins/src/activation/activate.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/agent-runtime/src/child-agent-options.ts`
- 修改：`packages/coordinator/src/coordinator-mode.ts`
- 修改：`packages/server/src/permissions/permission-broker.ts`
- 修改：上述文件的相应 `*.test.ts`

- [ ] **步骤 1：编写 canonicalize 与保留名失败测试**

```ts
expect(canonicalToolName("Bash")).toBe("Shell");
expect(canonicalToolName("Read")).toBe("Read");
expect(canonicalToolList(["Read", "Bash", "Shell"])).toEqual(["Read", "Shell"]);
expect(() => registerPluginTool({ name: "Shell" })).toThrow(/reserved/i);
expect(() => registerPluginTool({ name: "Bash" })).toThrow(/reserved/i);
```

- [ ] **步骤 2：运行定向测试确认迁移缺失**

运行：`pnpm --filter @vykor/core test -- tool-name-migration && pnpm --filter @vykor/permissions test && pnpm --filter @vykor/hooks test`
预期：FAIL。

- [ ] **步骤 3：实现唯一 canonicalizer**

```ts
export const RESERVED_SHELL_TOOL_NAMES = new Set(["Shell", "Bash"]);
export const canonicalToolName = (name: string): string => name === "Bash" ? "Shell" : name;
export const canonicalToolList = (names: readonly string[]): string[] =>
  [...new Set(names.map(canonicalToolName))];
```

它只用于 Vykor 自有配置/hook matcher 的读时迁移，不在 ToolRegistry 的 `get("Bash")` 中重定向。

- [ ] **步骤 4：接入所有名称消费者**

覆盖 `allowedTools`、`deniedTools`、`autoApproveTools`、`permission.rules[].tool`、`hostToolCeiling`、`roleAllowedTools`、`disallowedTools` 和 hook matcher。旧 session approval 不 canonicalize，以作废旧授权；新授权只写 `Shell`。

- [ ] **步骤 5：更新内置代理和 Workflow 的工具名**

使用 `rg -n 'Bash' packages apps/desktop/src` 逐项分类：生产配置全部改为 `Shell`；仅历史读取兼容和迁移测试允许保留字面量 `Bash`。

- [ ] **步骤 6：运行跨包测试**

运行：`pnpm --filter @vykor/core test && pnpm --filter @vykor/permissions test && pnpm --filter @vykor/hooks test && pnpm --filter @vykor/agent-runtime test && pnpm --filter @vykor/coordinator test`
预期：PASS。

- [ ] **步骤 7：提交**

```powershell
git add packages/core packages/permissions packages/hooks packages/plugins packages/agent-runtime packages/coordinator packages/server
git commit -m "refactor(runtime): migrate Bash tool references to Shell"
```

### 任务 6：从唯一 descriptor 生成 Prompt

**文件：**
- 修改：`packages/prompts/src/index.ts`
- 修改：`packages/prompts/src/prompt-segments-assembly.ts`
- 修改：`packages/prompts/src/index.test.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/agent-runtime/src/default-runtime.test.ts`

- [ ] **步骤 1：编写 Prompt 唯一来源失败测试**

```ts
const prompt = await buildRuntimeSystemPrompt({ environmentInfo: powershell51Info });
expect(prompt).toContain("Shell: Windows PowerShell 5.1");
expect(prompt).toContain("Temporary directory: C:\\Temp");
expect(prompt).not.toContain("Use Bash only");
expect(prompt).not.toContain("may be bash.exe, PowerShell, or cmd");
```

- [ ] **步骤 2：运行 Prompt 测试确认旧 Bash 说明仍存在**

运行：`pnpm --filter @vykor/prompts test`
预期：FAIL，基础 prompt 仍包含 `Use Bash`。

- [ ] **步骤 3：删除 getEnvironmentInfo 的独立 Shell 探测**

OS/date/Node/Git 等非 Shell 信息可继续采集；Shell、路径格式和临时目录只从 `environmentInfo.shellDescriptor` 读取。

- [ ] **步骤 4：将失败收敛规则写入通用工作风格**

```text
Do not repeat an identical failed tool call unless permissions, configuration,
the environment, the working directory, new evidence, or an explicit user retry changed the condition.
After a tool has obtained the target data, do not fetch the same target again without a new reason.
```

- [ ] **步骤 5：运行 prompts/agent-runtime 测试和类型检查**

运行：`pnpm --filter @vykor/prompts test && pnpm --filter @vykor/prompts check-types && pnpm --filter @vykor/agent-runtime test`
预期：PASS。

- [ ] **步骤 6：提交**

```powershell
git add packages/prompts packages/agent-runtime
git commit -m "refactor(prompts): describe the resolved session shell"
```

### 任务 7：持久化结果并兼容历史展示

**文件：**
- 修改：`packages/server/src/application/session/transcript-projection.ts`
- 修改：`packages/server/src/application/session/__test__/transcript-projection.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/message-render-model.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/message-render-model.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx`

- [ ] **步骤 1：编写新旧 metadata 展示测试**

```ts
expect(toolDisplayName(shellCall, shellResult({ shellDialect: "pwsh", shellDisplayName: "PowerShell 7" })))
  .toBe("PowerShell 7");
expect(toolDisplayName(legacyBashCall, legacyResult({ shellDialect: "powershell", shell: "powershell.exe" })))
  .toBe("PowerShell");
expect(toolDisplayName(legacyBashCall)).toBe("Shell");
```

- [ ] **步骤 2：运行测试确认新 metadata 尚未被消费**

运行：`pnpm --filter @vykor/server test -- transcript-projection && pnpm --filter @vykor/desktop test -- message-render-model`
预期：FAIL。

- [ ] **步骤 3：投影层原样持久化 ShellResultMetadata**

Transcript 只展开允许的 ShellResultMetadata 字段，不持久化 argsPrefix/environment。新 toolName 写 `Shell`，不改写历史行。

- [ ] **步骤 4：Desktop/CLI 优先展示 shellDisplayName**

新 metadata 使用 `shellDisplayName`；历史 `Bash` 数据使用旧 `shellDialect`/`shell`；什么都没有时显示 `Shell`，不显示 Bash。

- [ ] **步骤 5：运行 server/desktop 测试**

运行：`pnpm --filter @vykor/server test && pnpm --filter @vykor/desktop test`
预期：PASS。

- [ ] **步骤 6：提交**

```powershell
git add packages/server apps/desktop
git commit -m "feat(desktop): show the shell that executed each command"
```

### 任务 8：收敛同一 run 内的重复失败

**文件：**
- 创建：`packages/core/src/engine/tool-failure-memory.ts`
- 创建：`packages/core/src/engine/tool-failure-memory.test.ts`
- 修改：`packages/core/src/engine/query-engine.ts`
- 修改：`packages/core/src/engine/integration.test.ts`

- [ ] **步骤 1：编写 run-scoped 状态机失败测试**

```ts
const memory = new ToolFailureMemory();
memory.recordFailure("Shell", { command: "curl.exe URL" }, "exit:7");
expect(memory.shouldReplayFailure("Shell", { command: "curl.exe URL" })).toBe(true);
memory.noteEvidence("workdir_changed");
expect(memory.shouldReplayFailure("Shell", { command: "curl.exe URL" })).toBe(false);
```

另测试 timeout/spawn/runner 最多一次受控重试，exit-code 失败不自动原样重试，新 run 状态为空。

- [ ] **步骤 2：运行测试确认现有 Set 不支持 evidence revision**

运行：`pnpm --filter @vykor/core test -- tool-failure-memory integration`
预期：FAIL。

- [ ] **步骤 3：实现状态机并替换 failedUnsafeCalls**

```ts
type FailureEntry = {
  normalizedCommand: string;
  lastFailureFingerprint: string;
  attemptCount: number;
  evidenceRevision: number;
  replayableResult: ToolExecutionResult;
};
```

状态生命周期严格限定为一次 `query()` run。权限决策、环境配置、workdir、相关新工具结果或用户显式重试提升 revision。无新证据时返回缓存失败摘要和 `recoveryGuard: "repeated_failed_call"`。

- [ ] **步骤 4：运行 core 全量测试和类型检查**

运行：`pnpm --filter @vykor/core test && pnpm --filter @vykor/core check-types`
预期：PASS。

- [ ] **步骤 5：提交**

```powershell
git add packages/core
git commit -m "feat(core): converge repeated failed tool calls per run"
```

### 任务 9：建立确定性三端验收与离线回放

**文件：**
- 创建：`packages/tools/src/shell/__fixtures__/ai-radar-baseline.json`
- 创建：`packages/tools/src/shell/trace-eval.ts`
- 创建：`packages/tools/src/shell/trace-eval.test.ts`
- 测试：`packages/server/src/http/__test__/http.test.ts`
- 修改：`docs/superpowers/specs/2026-09-08-shell-runtime-contract-design.md`

- [ ] **步骤 1：将 34/17 轨迹脱敏为离线 fixture**

只保留 toolName、规范化输入哈希、failureKind、failureFingerprint、shellDialect、exitCode 和顺序；不保留本地用户路径、原始新闻内容或证书。

- [ ] **步骤 2：编写失败的评测器测试**

```ts
expect(evaluateShellTrace(baseline)).toMatchObject({ calls: 34, failures: 17 });
expect(evaluateShellTrace(improvedFixture)).toMatchObject({
  repeatedFailureFingerprints: 0,
  wrongDialectCommands: 0,
});
```

- [ ] **步骤 3：实现离线评估和本地 HTTP fixture**

使用 fake model 固定调用，使用本地 HTTP server 返回精简 JSON。阻塞 CI 不访问公网，不依赖真实模型随机性。

- [ ] **步骤 4：添加平台矩阵**

确定性用例覆盖 PowerShell 5.1、PowerShell 7、cmd、POSIX sh/bash/zsh。WSL 测试仅在 runner 可用时启用，但 WSL descriptor/argv 单元测试始终运行。

- [ ] **步骤 5：运行评测包与全仓验证**

运行：

```powershell
pnpm --filter @vykor/tools test -- src/shell/trace-eval.test.ts
pnpm --filter @vykor/server test -- src/http/__test__/http.test.ts
pnpm test
pnpm check-types
pnpm lint
pnpm build
```

预期：全部 PASS。若全仓检查命中已存在与本次无关的失败，单独记录命令、文件和错误，不将其表述为本次通过。

- [ ] **步骤 6：更新规格状态并提交**

将规格状态改为“已实施”，附上实际验证命令和结果摘要。

```powershell
git add packages/tools/src/shell packages/server/src/http docs/superpowers/specs/2026-09-08-shell-runtime-contract-design.md
git commit -m "test(evals): add cross-platform shell runtime coverage"
```

## 完成检查

- [ ] 模型可见 registry 中只有 `Shell`，`get("Bash")` 返回 undefined。
- [ ] 未修改任何第三方 `SKILL.md`。
- [ ] Local/WSL 每个会话只有一个不可变 descriptor。
- [ ] 前台、后台、Hook 和 Workflow Shell 命令不再重新探测 Shell。
- [ ] 新 metadata 符合 ShellResultMetadata，历史 Bash 会话仍可读。
- [ ] 旧权限/hook 配置读时迁移，旧 session approval 不被扩权复用。
- [ ] 插件无法注册 `Shell` 或 `Bash` 保留名。
- [ ] 同一 run 内无新证据的完全相同失败不再启动进程。
- [ ] Windows 中文 stdout/stderr 测试通过。
- [ ] 确定性 CI 不依赖公网或真实模型。
