# Clean-slate Stage 8C：消费者与底层包兼容清理实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除 CLI、Desktop、Frontend、Environment、Tools、Skills、Plugins 和 Agent Runtime 中明确服务旧 Vykor 入口的分支。

**架构：** 所有消费者调用当前 Client Resource。执行环境必须提供完整 `shellDescriptor`；技能只扫描 `.agents/skills` 与 `.vykor/skills`；Native Plugin 只接受当前 manifest 和 `user`/`managed` 安装 scope。

**技术栈：** TypeScript、React、Electron、Commander、Zod、Vitest、Bun test

---

## 文件结构

- 修改：`apps/cli/src/index.ts` 及 CLI 测试，删除 `--bare`。
- 修改：Desktop main services、renderer store/hook 及 Frontend 调用，统一领域 Resource。
- 修改：`packages/environment/src/types.ts`、`packages/tools/src/shell/shell.ts`。
- 修改：`packages/skills/src/index.ts`、`bundled.ts`、README 和测试。
- 修改：`packages/plugins/src/types.ts`、manifest schema、installation、activation、diagnostics 和测试。
- 删除：`packages/plugins/src/compatibility.ts` 及对应测试/export。
- 修改：`packages/plugin-converters`，仅删除旧 Vykor native schema 分支，保留 Codex/Claude 显式导入。
- 修改：`packages/agent-runtime` 的 plugin scope/environment 消费者。

### 任务 1：收口 CLI、Desktop 和 Frontend

- [ ] **步骤 1：增加旧 CLI 入口负向测试**

CLI 测试传入 `--bare`，断言 Commander 返回 unknown option；同时断言 `--no-plugins` 仍工作。把 `--bare` 加入 forbidden 清单 `cliOptions`。

- [ ] **步骤 2：删除 `--bare` 与别名分支**

修改 `apps/cli/src/index.ts`，插件开关只读取 `options.plugins`。用 `rg -n -- '--bare|\.bare\b' apps/cli packages docs/*.md` 确认除清单/负向测试外归零。

- [ ] **步骤 3：审核 Desktop/Frontend 的 facade**

运行：

```powershell
rg -n '\bclient\.[A-Za-z_$][\w$]*\(' apps/desktop apps/frontend apps/cli
rg -n '兼容入口|compatibility|deprecated' apps/desktop apps/frontend apps/cli
```

每个 Client 调用必须是 `client.<resource>.<method>()`。`desktop-session-store.ts` 若仅 re-export 当前 store，则消费者统一导入 `stores/desktop-session/index.ts` 后删除旧入口；若仍承担初始化职责，则重命名为该职责并保留实现。

- [ ] **步骤 4：运行消费者验证**

运行：

```powershell
pnpm --filter @vykor/cli check-types
pnpm --filter @vykor/cli test
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop test
pnpm --filter @vykor/frontend check-types
pnpm --filter @vykor/frontend test
```

预期：全部 PASS。

### 任务 2：删除 Terminal HTTP legacy adapter

- [ ] **步骤 1：把当前协议字段改成必填测试**

`packages/protocol/src/terminal.ts` 中 `TerminalCreateRequest.scope` 改为必填，删除兼容用的顶层 `projectId` 和 `sessionId`。类型 fixture 对缺失 scope、只给 `projectId`、只给 `sessionId` 分别使用 `@ts-expect-error`，当前请求使用：

```ts
const request: TerminalCreateRequest = {
  scope: { kind: "session", sessionId: "session-1" },
  runtime: "environment",
  cols: 120,
  rows: 30,
};
```

- [ ] **步骤 2：删除 route adapter**

`packages/server/src/http/routes/terminal.ts` 只解析 `body.scope`，删除从顶层 `projectId`/`sessionId` 合成 scope 的 `readTerminalScope` 兼容分支；无 scope 在创建进程前返回当前 schema validation 错误。

- [ ] **步骤 3：迁移 Client/Desktop 当前调用**

所有 terminal create 调用显式构造 scope，不在 Client Resource 内补默认 scope。把 `projectId`、`sessionId` 顶层旧字段加入 forbidden 清单的 `configFields`，scanner 只在 `TerminalCreateRequest`/terminal create payload 上下文匹配，避免误伤当前 `TerminalSessionInfo.projectId/sessionId`。

- [ ] **步骤 4：验证协议与 terminal routes**

运行：

```powershell
pnpm --filter @vykor/protocol test
pnpm --filter @vykor/client test
pnpm --filter @vykor/server exec vitest run src/http/routes/terminal.test.ts
pnpm --filter @vykor/desktop typecheck
```

预期：全部 PASS。

### 任务 3：强制 ShellDescriptor 当前契约

- [ ] **步骤 1：先把类型改为必填并观察失败调用方**

`ExecutionEnvironmentInfo` 固定为：

```ts
export interface ExecutionEnvironmentInfo {
  kind: ExecutionEnvironmentKind;
  cwd: string;
  shellDescriptor: ShellDescriptor;
}
```

运行 `pnpm --filter @vykor/environment check-types` 和 `pnpm --filter @vykor/tools check-types`，记录所有缺失构造点。

- [ ] **步骤 2：补齐当前环境实现和测试 fixture**

Native 与 WSL environment 在创建 info 时显式提供 kind、executable、args、path style 等当前字段；测试 fixture 不再只填 `shell`/`shellArgs` 标量。

- [ ] **步骤 3：删除 Tools 回退**

`packages/tools/src/shell/shell.ts` 直接读取 `environment.info.shellDescriptor`；删除 `legacyShellDescriptor` 和 `isLegacyWindowsPowerShell`。保留 `fallbackToHost`，因为它是当前 sandbox fail-open/fail-closed 策略，不是格式兼容。

- [ ] **步骤 4：验证环境与工具包**

运行：

```powershell
pnpm --filter @vykor/environment test
pnpm --filter @vykor/tools test
pnpm --filter @vykor/environment check-types
pnpm --filter @vykor/tools check-types
```

预期：PASS。

### 任务 4：删除 `.claude/skills` 隐式扫描

- [ ] **步骤 1：改写目录发现测试**

fixture 同时创建 `.agents/skills/review`、`.vykor/skills/local`、`.claude/skills/old`；断言前两者加载、最后一个完全忽略。

- [ ] **步骤 2：删除扫描分支与说明**

`collectProjectSkillDirectories()` 每层只返回 `.agents/skills` 和 `.vykor/skills`。更新 bundled create-skill 指令和 `packages/skills/README.md`，不再把 `.claude/skills` 描述为可读布局。

- [ ] **步骤 3：验证 Skills**

运行：`pnpm --filter @vykor/skills test && pnpm --filter @vykor/skills check-types`

预期：PASS；`.claude/skills` 只在负向测试和 forbidden 清单出现。

### 任务 5：收口 Native Plugin schema 与 scope

- [ ] **步骤 1：写严格 schema 与 scope 负向测试**

manifest 含 `compatibility` 时 Zod strict parse 失败；安装记录含 `project` 或 `local` scope 时 parse 失败；`user` 和 `managed` 正常。managed 插件仍禁止修改、卸载和覆盖。

- [ ] **步骤 2：删除兼容实现**

从 manifest type/schema 删除 `compatibility`；删除 `buildNativePluginCompatibilityEnvironment` 文件、export 与调用；删除 environment alias 注入；installation store/installer 只接受：

```ts
export type NativePluginInstallScope = "user" | "managed";
```

- [ ] **步骤 3：检查 converters 边界**

保留 `packages/plugin-converters/src/codex/**` 与 `claude-code/**` 的显式外部导入。只删除生成旧 `compatibility` 字段、旧 scope 或旧 Native manifest 字段的 mapping；转换结果必须通过当前 `VykorPluginManifestV1Schema`。

- [ ] **步骤 4：迁移 Agent Runtime 消费者**

Runtime 只按 `user`/`managed` 和当前 manifest 组装能力；删除旧 scope warning、alias 环境变量和旧 fixture。

- [ ] **步骤 5：验证相关包**

运行：

```powershell
pnpm --filter @vykor/plugins test
pnpm --filter @vykor/plugins check-types
pnpm --filter @vykor/plugin-converters test
pnpm --filter @vykor/plugin-converters check-types
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/agent-runtime check-types
```

预期：全部 PASS。

- [ ] **步骤 6：提交 8C**

```powershell
git add apps packages/environment packages/tools packages/skills packages/plugins packages/plugin-converters packages/agent-runtime scripts/forbidden-compatibility-surfaces.json
git commit -m "refactor: remove consumer and package compatibility paths"
```
