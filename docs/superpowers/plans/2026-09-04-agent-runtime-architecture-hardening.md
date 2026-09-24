# agent-runtime 架构审查硬化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消化 `packages/agent-runtime` 架构审查中的四项可落地问题——公开错误类可 `instanceof`、拆薄 `createVykorRuntime`、澄清 peerDeps 语义、补齐纯组合层单测——同时用信任边界回归套件做改动前基线，避免踩进 toolOverrides 收敛中间态。

**架构：** 不改对外行为与依赖方向。错误类从 `@vykor/core` **再导出**到两个稳定入口（完整包与 `/kernel`），而不是让外部依赖不可独立安装的 core。`default-runtime.ts` 只保留编排；工具注册、provider 解析、sandbox/exit cleanup 拆到同目录私有模块。文档明确 peerDeps `optional: true` 是发布/安装人体工程学，不是可插拔替换契约。单测优先覆盖有运行时逻辑的纯函数；`native-tools/protocol.ts` 确认仅为类型定义后不做空测。

**技术栈：** TypeScript、Vitest、pnpm workspace、`@vykor/agent-runtime` 现有测试布局。

**非目标：**

- 不继续改 `trustedToolOverrides` / 附件视觉信任边界的产品语义（审查认定这两条线仍在冷却，本计划只跑回归、不扩功能）。
- 不把 `@vykor/core` 改成可独立 npm 安装包。
- 不为 `protocol.ts` 的纯 interface 发明解析器只为“有测试”。
- 不改 `createVykorRuntime` / `composeVykorAgent` 的公开签名。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `packages/agent-runtime/src/index.ts` | 默认入口再导出两个错误类 |
| `packages/agent-runtime/src/kernel-entry.ts` | Kernel 入口再导出同一组错误类 |
| `packages/agent-runtime/src/public-surface.test.ts` | 锁定两个入口的导出面与 `instanceof` |
| `packages/agent-runtime/src/default-runtime-tools.ts` | 工具新增/覆盖校验、`RuntimeToolRegistry`、内部 registry 取出 |
| `packages/agent-runtime/src/default-runtime-provider.ts` | API client / backend 解析 |
| `packages/agent-runtime/src/default-runtime-sandbox.ts` | sandbox 挂接与 `process.exit` 清理登记 |
| `packages/agent-runtime/src/default-runtime.ts` | 只编排：校验 → client → tools → permissions → prompt → engine → sandbox |
| `packages/agent-runtime/src/agent-errors.test.ts` | `abortError` / `serializeError` 单测 |
| `docs/agent-sdk.md` | 文档化可 `instanceof` 的错误类与 peer 语义摘要 |
| `docs/agent-framework-capability-boundary.md` | 发布形态小节补 peerDeps 说明 |

信任边界基线（只跑、不改产品语义）：

- `packages/agent-runtime/src/default-runtime.test.ts`
- `packages/agent-runtime/src/extensions.test.ts`
- `packages/agent-runtime/src/mcp-auth.test.ts`

---

### 任务 0：信任边界基线（改动前闸门）

**文件：** 无修改；只验证。

- [ ] **步骤 1：运行信任边界相关测试**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run \
  src/default-runtime.test.ts \
  src/extensions.test.ts \
  src/mcp-auth.test.ts
```

预期：全部 PASS。若失败，**停止本计划**，先按 systematic-debugging 处理信任边界回归，再回来。

- [ ] **步骤 2：记录基线结果**

在实现笔记或 PR 描述中写明上述三条文件均已绿，作为后续重构的对照基线。无需 commit。

---

### 任务 1：公开错误类再导出 + 导出面测试

**决定：** 采用审查建议的「重新导出」路径，不采用「只能按 `error.name` 区分」——后者与「两个稳定发布入口」矛盾，且 `server` 已在用 `instanceof`。

**文件：**

- 修改：`packages/agent-runtime/src/index.ts`
- 修改：`packages/agent-runtime/src/kernel-entry.ts`
- 创建：`packages/agent-runtime/src/public-surface.test.ts`
- 修改：`docs/agent-sdk.md`（错误类小节，见步骤 5）

- [ ] **步骤 1：编写失败的导出面测试**

创建 `packages/agent-runtime/src/public-surface.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  AgentChildBudgetExceededError as CoreBudgetError,
  AgentRunNotAcceptingInputError as CoreSteerError,
} from "@vykor/core";

import * as runtime from "./index.js";
import * as kernel from "./kernel-entry.js";

describe("agent-runtime public error surface", () => {
  it("re-exports steer and budget errors from the default entry", () => {
    expect(runtime.AgentRunNotAcceptingInputError).toBe(CoreSteerError);
    expect(runtime.AgentChildBudgetExceededError).toBe(CoreBudgetError);
  });

  it("re-exports steer and budget errors from the kernel entry", () => {
    expect(kernel.AgentRunNotAcceptingInputError).toBe(CoreSteerError);
    expect(kernel.AgentChildBudgetExceededError).toBe(CoreBudgetError);
  });

  it("keeps instanceof identity with core-thrown instances", () => {
    const steer = new CoreSteerError("run-1");
    const budget = new CoreBudgetError("depth", 2, 3);
    expect(steer).toBeInstanceOf(runtime.AgentRunNotAcceptingInputError);
    expect(budget).toBeInstanceOf(runtime.AgentChildBudgetExceededError);
    expect(steer).toBeInstanceOf(kernel.AgentRunNotAcceptingInputError);
    expect(budget).toBeInstanceOf(kernel.AgentChildBudgetExceededError);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/public-surface.test.ts
```

预期：FAIL（`AgentRunNotAcceptingInputError` / `AgentChildBudgetExceededError` 未从入口导出）。

- [ ] **步骤 3：在两个入口再导出**

在 `packages/agent-runtime/src/index.ts` 顶部附近增加：

```ts
export {
  AgentChildBudgetExceededError,
  AgentRunNotAcceptingInputError,
} from "@vykor/core";
```

在 `packages/agent-runtime/src/kernel-entry.ts` 同样增加上述导出块（与现有 `AgentOperationConflictError` 并列，便于消费方从任一稳定入口拿到类型错误类）。

- [ ] **步骤 4：运行测试确认通过**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/public-surface.test.ts
```

预期：PASS。

- [ ] **步骤 5：更新 SDK 文档**

在 `docs/agent-sdk.md` 的「Run Handle」与「Child Agent」之间插入小节：

```markdown
## 稳定错误类

以下错误类从 `@vykor/agent-runtime` 与 `@vykor/agent-runtime/kernel` 再导出，可用 `instanceof` 判断（与 `@vykor/core` 内定义为同一引用）：

| 错误类 | 何时抛出 |
|---|---|
| `AgentRunNotAcceptingInputError` | run 已关闭 steering / 不再接受输入 |
| `AgentChildBudgetExceededError` | child 深度、活动数或累计创建数超预算 |
| `AgentOperationConflictError` | Agent 在非法状态下执行操作（如 closed 后 `submitMessage`） |

不要依赖解析 `error.message` 字符串。workspace 内的 `@vykor/core` 不是独立发布包；外部消费方应只从上述两个 agent-runtime 入口导入。
```

- [ ] **步骤 6：Commit**

```bash
git add packages/agent-runtime/src/index.ts \
  packages/agent-runtime/src/kernel-entry.ts \
  packages/agent-runtime/src/public-surface.test.ts \
  docs/agent-sdk.md
git commit -m "$(cat <<'EOF'
fix(agent-runtime): re-export steer and budget errors from stable entries

External consumers cannot install @vykor/core alone; re-export the
instanceof-stable error classes from both package entry points.
EOF
)"
```

---

### 任务 2：拆薄 `createVykorRuntime`（对外 API 不变）

**拆分边界（按职责，不按技术层）：**

1. **tools** — `applyConfiguredTools`、`assertUniqueToolNames`、`RuntimeToolRegistry`、`getInternalToolRegistry`
2. **provider** — `resolveApiClient`、`resolveBackendFromFormat`（`resolveCustomProviderRuntime` 一并迁入并继续从 `default-runtime.ts` 再导出，避免破坏现有测试 import）
3. **sandbox** — `attachSandboxRuntime`、`registerExitCleanup` 及模块级 `bundlesWithExitCleanup` / `exitCleanupInstalled`

`resolveAutoApproveTools`、`resolveRuntimeModel`、`resolveEffectiveAllowedTools` 及 `ToolLimit` 类型可仍留在 `default-runtime.ts`（已有独立单测），或随 tools 模块迁出但必须从 `default-runtime.ts` 再导出以保持 `default-runtime.test.ts` 的 import 路径不变。

**文件：**

- 创建：`packages/agent-runtime/src/default-runtime-tools.ts`
- 创建：`packages/agent-runtime/src/default-runtime-provider.ts`
- 创建：`packages/agent-runtime/src/default-runtime-sandbox.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`（变薄为编排）

- [ ] **步骤 1：先跑现有 default-runtime 测试作对照**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/default-runtime.test.ts
```

预期：PASS（与任务 0 一致）。

- [ ] **步骤 2：提取 tools 模块**

创建 `default-runtime-tools.ts`，迁入：

- `applyConfiguredTools`
- `assertUniqueToolNames`
- `RuntimeToolRegistry`（可保持非 export，仅同文件使用）
- `getInternalToolRegistry`（继续 export）

从 `default-runtime.ts` 的 `createVykorRuntime` 改为：

```ts
import {
  applyConfiguredTools,
  getInternalToolRegistry,
  createVisibilityToolRegistry,
} from "./default-runtime-tools.js";
```

若希望 `RuntimeToolRegistry` 构造不外泄，可导出工厂：

```ts
export function createVisibilityToolRegistry(
  inner: IToolRegistry,
  allowedTools: ToolLimit,
  deniedTools: ReadonlySet<string>,
): IToolRegistry {
  return new RuntimeToolRegistry(inner, allowedTools, deniedTools);
}

export { getInternalToolRegistry };
```

行为必须与迁出前逐行等价（含 `trustedToolOverrides` 校验文案）。

- [ ] **步骤 3：提取 provider 模块**

创建 `default-runtime-provider.ts`，迁入 `resolveApiClient`、`resolveBackendFromFormat`、`resolveCustomProviderRuntime` 及相关类型 `CustomProviderRuntimeConfig`。

在 `default-runtime.ts` 再导出：

```ts
export {
  resolveCustomProviderRuntime,
  type CustomProviderRuntimeConfig,
} from "./default-runtime-provider.js";
```

保证 `default-runtime.test.ts` 仍可 `from "./default-runtime.js"` 导入。

- [ ] **步骤 4：提取 sandbox 模块**

创建 `default-runtime-sandbox.ts`，迁入模块级 exit cleanup 状态与：

```ts
export async function attachSandboxRuntime(
  bundle: RuntimeBundle,
  cwd: string,
  reporter?: SandboxRuntimeReporter,
  sessionId?: string,
): Promise<void>;
```

`createVykorRuntime` 末尾继续 `await attachSandboxRuntime(...)`。

- [ ] **步骤 5：确认编排函数只剩阶段串联**

`createVykorRuntime` 目标形态（示意，非逐字锁定）：

```ts
export async function createVykorRuntime(options: VykorRuntimeOptions): Promise<RuntimeBundle> {
  // 1. validate lifecycle tool names
  // 2. resolveApiClient
  // 3. createDefaultToolRegistry + applyConfiguredTools + visibility registry
  // 4. PermissionChecker + HookExecutor + system prompt
  // 5. QueryEngine + RuntimeBuilder.build
  // 6. attachSandboxRuntime
  // return bundle
}
```

函数体宜落在约 80–100 行量级；禁止在此步骤改变工具信任或 sandbox 语义。

- [ ] **步骤 6：运行回归**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run \
  src/default-runtime.test.ts \
  src/extensions.test.ts \
  src/mcp-auth.test.ts \
  src/agent.test.ts \
  src/sdk.test.ts
```

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add packages/agent-runtime/src/default-runtime.ts \
  packages/agent-runtime/src/default-runtime-tools.ts \
  packages/agent-runtime/src/default-runtime-provider.ts \
  packages/agent-runtime/src/default-runtime-sandbox.ts
git commit -m "$(cat <<'EOF'
refactor(agent-runtime): split createVykorRuntime helpers

Move tool registration, provider resolution, and sandbox exit cleanup into
private modules so the composition root only orchestrates stages.
EOF
)"
```

---

### 任务 3：澄清 peerDependencies `optional: true` 语义

**决定：** 保留现有 `peerDependenciesMeta.*.optional: true` 与值导入 + esbuild bundle 现状（改标注会牵动安装体验）；在权威架构文档写清「不是可替换实现点」。

**文件：**

- 修改：`docs/agent-framework-capability-boundary.md`（「发布形式」小节）
- 修改：`docs/agent-sdk.md`（源码索引前加一小段，或并入任务 1 的错误类节后）

- [ ] **步骤 1：在能力边界文档补说明**

在 `docs/agent-framework-capability-boundary.md`「发布形式」中 `workspace 包只作为开发期和类型 peer` 一句后追加：

```markdown
`package.json` 里这些 peer 标了 `optional: true`，且源码对它们是**值导入**（不是 `import type`）。这不表示第三方可以自行提供替代实现：发布构建会用 esbuild 把 api/auth/core/tools/mcp/plugins 等一并打进 `dist/`，运行时不依赖消费者再装一套可互换的 peer。`optional: true` 只是避免 monorepo / 局部安装时 peer 警告噪声；消费方仍应把 `@vykor/agent-runtime` 当作自带组装内核的意见化 SDK，而不是可热插拔的 facade。
```

- [ ] **步骤 2：在 SDK 文档交叉引用**

在 `docs/agent-sdk.md`「定位」末或「非目标」前加一句：

```markdown
发布包的 peerDependencies 标为 optional，是安装人体工程学；实现已 bundle，不要假设可以替换 `@vykor/core` / `@vykor/tools` 等 peer 实现。细节见 [Agent Framework Capability Boundary](../../agent-framework-capability-boundary.md)。
```

（若本地 markdown 锚点与标题 slug 不一致，改用完整相对链接不加锚点。）

- [ ] **步骤 3：Commit**

```bash
git add docs/agent-framework-capability-boundary.md docs/agent-sdk.md
git commit -m "$(cat <<'EOF'
docs(agent-runtime): clarify optional peerDependencies are not swappable

Call out that optional peers plus value imports are bundled at publish time,
so consumers must not treat them as replaceable implementations.
EOF
)"
```

---

### 任务 4：补齐纯组合层单测

**范围裁定：**

| 模块 | 动作 |
|------|------|
| `agent-errors.ts` | 新增独立单测（有运行时逻辑） |
| `agent-composition.ts` | 不新增重型集成替身；其失败回滚已由 `cleanup-stack.test.ts` + `sdk.test.ts` 覆盖。本任务只确认无新增未测纯函数；若任务 2 抽出的 tools 校验仍仅靠集成测，则在 `default-runtime-tools` 增加针对 `applyConfiguredTools` 的聚焦测（见步骤 3） |
| `native-tools/protocol.ts` | 确认仅为 interface / type 后，在计划验收备注中写明「无运行时逻辑，不造空测」 |

**文件：**

- 创建：`packages/agent-runtime/src/agent-errors.test.ts`
- 可选修改：`packages/agent-runtime/src/default-runtime-tools.test.ts`（若步骤 3 需要）

- [ ] **步骤 1：编写 `agent-errors` 失败测试**

创建 `packages/agent-runtime/src/agent-errors.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  AgentOperationConflictError,
  abortError,
  serializeError,
} from "./agent-errors.js";

describe("abortError", () => {
  it("returns the AbortSignal reason when it is an Error", () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);
    expect(abortError(controller.signal)).toBe(reason);
  });

  it("wraps string reasons and falls back for empty reasons", () => {
    const withString = new AbortController();
    withString.abort("caller cancelled");
    expect(abortError(withString.signal)).toEqual(
      expect.objectContaining({ message: "caller cancelled" }),
    );

    const bare = new AbortController();
    bare.abort();
    expect(abortError(bare.signal).message).toMatch(/interrupted/i);
  });
});

describe("serializeError", () => {
  it("serializes Error fields and optional code", () => {
    const error = Object.assign(new Error("boom"), { code: "E_TEST" });
    error.stack = "stack-line";
    expect(serializeError(error)).toEqual({
      name: "Error",
      message: "boom",
      code: "E_TEST",
      stack: "stack-line",
    });
  });

  it("stringifies non-Error values", () => {
    expect(serializeError("nope")).toEqual({ name: "Error", message: "nope" });
  });
});

describe("AgentOperationConflictError", () => {
  it("sets a stable name and message", () => {
    const error = new AgentOperationConflictError("a1", "closed", "submitMessage");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AgentOperationConflictError");
    expect(error.message).toContain("closed");
    expect(error.agentId).toBe("a1");
  });
});
```

- [ ] **步骤 2：运行并实现（逻辑已存在，应直接 PASS）**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/agent-errors.test.ts
```

预期：PASS。若因 `abort()` 无 reason 时平台差异导致 message 断言失败，按实际 `abortError` 实现收紧/放宽断言，**不要改生产代码语义**。

- [ ] **步骤 3：为抽出的 tools 校验补聚焦测（若任务 2 已抽出）**

创建 `packages/agent-runtime/src/default-runtime-tools.test.ts`，至少覆盖：

1. `tools` 与 `toolOverrides` 同名互斥报错  
2. `trustedToolOverrides` 必须出现在 `toolOverrides`  
3. `trustedToolOverrides` 目标必须是 builtin  
4. 成功路径返回的 trusted 名称集合  

使用内存 `ToolRegistry`（`@vykor/core`）注册一个 builtin `Read`，再调用导出的 `applyConfiguredTools`（若当前未 export，为测试 export 该函数，或测试通过 `createVykorRuntime` 的现有用例保持、并在本步骤注明「已由 default-runtime.test.ts 覆盖、不重复」）。**优先**：若 `default-runtime.test.ts` 已完整覆盖上述四条，则本步骤改为在验收清单勾选「已覆盖，不重复造测」，避免双份脆弱断言。

- [ ] **步骤 4：确认 protocol.ts 无运行时逻辑**

```bash
# 应只有 interface/type，无 function/class 实现
rg "^(export )?(async )?function|^(export )?class" packages/agent-runtime/src/native-tools/protocol.ts
```

预期：无匹配。在 PR/提交说明写一句：审查项 4 中 protocol 为类型文件，不新增单测。

- [ ] **步骤 5：Commit**

```bash
git add packages/agent-runtime/src/agent-errors.test.ts
# 若创建了 default-runtime-tools.test.ts 一并加入
git commit -m "$(cat <<'EOF'
test(agent-runtime): unit-cover agent-errors helpers

Add focused tests for abort/serialize/conflict errors that previously
relied only on large state-machine suites.
EOF
)"
```

---

### 任务 5：验收

**文件：** 无新功能；验证与人工核对。

- [ ] **步骤 1：agent-runtime 全包测试**

```bash
pnpm --filter @vykor/agent-runtime test
```

预期：PASS。

- [ ] **步骤 2：类型检查**

```bash
pnpm --filter @vykor/agent-runtime check-types
```

预期：PASS。

- [ ] **步骤 3：导出面与信任边界再跑一遍**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run \
  src/public-surface.test.ts \
  src/default-runtime.test.ts \
  src/extensions.test.ts \
  src/mcp-auth.test.ts
```

预期：PASS。

- [ ] **步骤 4：`git diff --check` 与人工审查**

```bash
git diff --check
```

核对清单：

- [ ] 两个入口都能 `instanceof` 到 steer/budget 错误  
- [ ] `createVykorRuntime` 对外签名未变
- [ ] peerDeps 文档已说明「非可替换」  
- [ ] 未改动 `trustedToolOverrides` 产品语义  
- [ ] `protocol.ts` 未为凑覆盖而发明解析器  

- [ ] **步骤 5（可选）：`test:pack`**

若本分支准备合并/发布，再跑：

```bash
pnpm --filter @vykor/agent-runtime test:pack
```

预期：tarball 外安装仍能跑通 root/child/close。非合并门禁时可不跑。

---

## 自检

| 审查项 | 对应任务 |
|--------|----------|
| 中高：错误类未从稳定入口导出 | 任务 1 |
| 中：`createVykorRuntime` 职责过重 | 任务 2 |
| 低中：peerDeps optional 误导 | 任务 3 |
| 低：组合层单测不均 | 任务 4（errors + tools 聚焦；protocol 明示跳过） |
| 信任边界仍在冷却 | 任务 0 + 任务 5 回归闸门 |

占位符扫描：无 TODO/待定步骤。类型名与现有 `AgentRunNotAcceptingInputError` / `AgentChildBudgetExceededError` / `AgentOperationConflictError` 保持一致。
