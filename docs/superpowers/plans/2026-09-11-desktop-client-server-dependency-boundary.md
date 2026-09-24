# Desktop client/server 依赖边界收敛实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Desktop 的 Vykor workspace 直接依赖收敛为 `@vykor/client` 和 `@vykor/server`，同时保持 terminal、WSL 与 daemon 常驻行为不回归。

**架构：** 所有 HTTP/SSE 操作和协议类型归 `client`；daemon 未启动时也必须可用的 registry、系统服务和 autostart 协调归 `server/daemon-host` 本地子入口。`core`、`sandbox`、`terminal-node` 继续作为 server 内部实现依赖，Desktop 不直接感知。

**技术栈：** TypeScript、Electron、Hono、Vitest、pnpm workspace、electron-vite。

---

## 文件结构

### Terminal 类型边界

- 修改 `apps/desktop/src/shared/terminal-types.ts`：从 client 导入 terminal 协议类型。
- 修改 `apps/desktop/src/main/features/terminal/terminal-service.ts`：从 client 同时导入客户端和 terminal 类型。
- 修改 `apps/desktop/package.json`、`pnpm-lock.yaml`：删除 terminal、terminal-node 直接声明。

### WSL daemon 端校验

- 修改 `packages/server/src/application/settings-api.ts`：增加执行环境能力类型。
- 修改 `packages/server/src/application/default-services/settings-service.ts` 及测试：注入环境 probe/validator，在保存 WSL 设置前校验。
- 修改 `packages/server/src/application/default-application-services.ts`：默认注入 sandbox WSL 实现。
- 修改 `packages/server/src/http/routes/system.ts` 及测试：增加执行环境能力读取路由。
- 修改 `packages/client/src/transport/http-client.ts`、`packages/client/src/index.ts` 及测试：暴露类型安全的能力读取方法。
- 修改 `apps/desktop/src/main/features/settings/settings-service.ts` 及测试：只通过 client 获取能力和更新设置。
- 修改 `apps/desktop/package.json`、`pnpm-lock.yaml`：删除 sandbox 直接声明。

### daemon-host 本地入口

- 创建 `packages/server/src/daemon-host/index.ts`：本地宿主公共子入口。
- 移动 `packages/server/src/daemon/system-service.ts` 到 `packages/server/src/daemon-host/system-service.ts`。
- 创建 `packages/server/src/daemon-host/auto-start-controller.ts` 及测试：统一配置、系统服务和失败收敛。
- 修改 `packages/server/package.json`：增加 `./daemon-host` export。
- 修改 `packages/server/src/daemon/index.ts`、`packages/server/src/index.ts`：停止从根入口暴露本地系统服务管理器。
- 修改 `apps/cli/src/daemon-system-service.ts`、`apps/cli/src/daemon-auto-start.ts` 及测试：复用 daemon-host。
- 修改 `apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.ts`、`daemon-entry.ts` 及测试：删除 core 直接调用，组合 daemon-host 快照与 Desktop onboarding。
- 修改 `apps/desktop/src/main/features/session/session-service.ts`：宿主启动和 registry 导入切到 daemon-host。
- 修改 `apps/desktop/package.json`、`pnpm-lock.yaml`：删除 core 直接声明。

### 边界检查与文档

- 创建 `apps/desktop/scripts/verify-workspace-boundaries.mjs`：禁止 Desktop 导入其他 workspace 包，并限制 server 只能在 main 使用。
- 修改 `apps/desktop/package.json`：把边界检查接入 test/build。
- 修改 `apps/desktop/docs/packaging.md`、`apps/desktop/README.md`、`docs/daemon-system-service.md`：记录最终边界。
- 修改 `docs/superpowers/specs/2026-09-11-desktop-daemon-autostart-design.md`：修订旧的 Desktop 直接配置/系统服务描述。
- 保持 `apps/desktop/electron.vite.config.ts` 的 migration 复制路径不变。

## 任务 1：移除 terminal 与 terminal-node 直接依赖

**文件：**
- 修改：`apps/desktop/src/shared/terminal-types.ts`
- 修改：`apps/desktop/src/main/features/terminal/terminal-service.ts`
- 修改：`apps/desktop/package.json`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：增加依赖清单失败断言**

在后续边界脚本落地前，先用现有打包检查锁定包清单：

```js
for (const name of ["@vykor/terminal", "@vykor/terminal-node"]) {
  if (packageJson.devDependencies?.[name]) {
    failures.push(`${name} must be consumed through client/server`)
  }
}
```

- [ ] **步骤 2：运行检查确认当前失败**

运行：

```powershell
node apps/desktop/scripts/verify-update-packaging.mjs
```

预期：FAIL，报告 terminal 和 terminal-node 仍是 Desktop 直接依赖。

- [ ] **步骤 3：将类型导入切到 client 并删除声明**

`terminal-types.ts` 改为：

```ts
import type {
  TerminalCreateRequest,
  TerminalEvent,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalWriteRequest,
} from "@vykor/client"
```

`terminal-service.ts` 也从 client 的同一个 import 中取得 `VykorClient` 和 terminal 类型。删除 package.json 与 lockfile 中两个直接声明，但保留 electron-vite 的 terminal/terminal-node bundling exclude。

- [ ] **步骤 4：运行类型、测试、构建和裸导入扫描**

运行：

```powershell
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop test
pnpm --filter @vykor/desktop exec electron-vite build
rg 'from ["'']@vykor/|require\(["'']@vykor/' apps/desktop/out/main -g '*.js'
```

预期：前三条通过；最后一条没有输出。

- [ ] **步骤 5：提交 Terminal 边界收敛**

```powershell
git add apps/desktop/src/shared/terminal-types.ts apps/desktop/src/main/features/terminal/terminal-service.ts apps/desktop/scripts/verify-update-packaging.mjs apps/desktop/package.json pnpm-lock.yaml
git commit -m "refactor(desktop): consume terminal through client"
```

## 任务 2：将 WSL 能力探测和设置校验移到 daemon

**文件：**
- 修改：`packages/server/src/application/settings-api.ts`
- 修改：`packages/server/src/application/default-services/settings-service.ts`
- 修改：`packages/server/src/application/__test__/default-application-services.test.ts`
- 修改：`packages/server/src/application/default-application-services.ts`
- 修改：`packages/server/src/http/routes/system.ts`
- 修改：`packages/server/src/http/__test__/http.test.ts`
- 修改：`packages/client/src/transport/http-client.ts`
- 修改：`packages/client/src/transport/__test__/http-client.test.ts`
- 修改：`packages/client/src/index.ts`
- 修改：`apps/desktop/src/main/features/settings/settings-service.ts`
- 修改：`apps/desktop/src/main/features/settings/settings-service.test.ts`
- 修改：`apps/desktop/package.json`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：编写 server 保存前校验失败测试**

定义窄能力：

```ts
export interface AgentEnvironmentCapabilities {
  native: true
  wsl: boolean
}

export interface AgentEnvironmentService {
  capabilities(): Promise<AgentEnvironmentCapabilities>
  validate(kind: "native" | "wsl"): Promise<void>
}
```

测试 `agentEnvironment=wsl` 时先调用 validator，成功才保存；validator 抛错时 `ref.current` 保持原值。`native` 仍可直接保存。

- [ ] **步骤 2：编写 HTTP/client/Desktop 失败测试**

固定接口：

```ts
client.getAgentEnvironmentCapabilities()
// => { native: true, wsl: boolean }
```

HTTP 测试断言 `GET /settings/environment-capabilities` 返回 daemon 宿主结果。Desktop 测试断言不再调用本机 `preflightWsl`，而是通过 `patchSettings` 接收 server 错误；snapshot 使用 daemon capabilities 设置 `wslSupported`。

- [ ] **步骤 3：运行测试确认新能力不存在**

运行：

```powershell
pnpm --filter @vykor/server test -- default-application-services http
pnpm --filter @vykor/client test -- http-client
pnpm --filter @vykor/desktop test -- settings-service
```

预期：FAIL，缺少 environment service、HTTP 路由和 client 方法。

- [ ] **步骤 4：实现 server 注入与 client API**

`createDefaultSettingsService(ref, { agentEnvironment })` 在计算 effective patch 后、`saveSettingsAndRefreshRef()` 前调用：

```ts
const kind = readAgentEnvironmentKind(effectivePatch)
if (kind) await options.agentEnvironment.validate(kind)
```

默认 composition 用 `process.platform` 和 sandbox `preflightWsl()` 实现 capabilities/validate。HTTP 路由只暴露能力探测和 settings patch，不暴露任意命令执行。

Desktop `SettingsClient` 增加 `getAgentEnvironmentCapabilities`，删除 `preflightWsl` 与 `platform` dependencies。加载设置时并行请求 settings 和 capabilities；更新 WSL 时直接 patch，由 daemon 返回不可用错误。

- [ ] **步骤 5：验证并删除 sandbox 声明**

运行：

```powershell
pnpm --filter @vykor/server test
pnpm --filter @vykor/client test
pnpm --filter @vykor/desktop test
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
pnpm --filter @vykor/desktop typecheck
```

预期：全部通过。随后删除 Desktop package.json/lockfile 的 sandbox 直接依赖并重新运行 Desktop typecheck。

- [ ] **步骤 6：提交 WSL 责任迁移**

```powershell
git add packages/server/src/application packages/server/src/http packages/client/src apps/desktop/src/main/features/settings apps/desktop/package.json pnpm-lock.yaml
git commit -m "refactor(settings): validate WSL on daemon host"
```

## 任务 3：建立 daemon-host 并统一 autostart controller

**文件：**
- 创建：`packages/server/src/daemon-host/index.ts`
- 移动：`packages/server/src/daemon/system-service.ts` → `packages/server/src/daemon-host/system-service.ts`
- 创建：`packages/server/src/daemon-host/auto-start-controller.ts`
- 创建：`packages/server/src/daemon-host/__test__/auto-start-controller.test.ts`
- 修改：`packages/server/package.json`
- 修改：`packages/server/src/daemon/index.ts`
- 修改：`packages/server/src/index.ts`
- 修改：`apps/cli/src/daemon-system-service.ts`
- 修改：`apps/cli/src/daemon-auto-start.ts`
- 修改：`apps/cli/src/daemon-auto-start.test.ts`
- 修改：`apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.ts`
- 修改：`apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.test.ts`
- 修改：`apps/desktop/src/main/features/daemon-autostart/daemon-entry.ts`
- 修改：`apps/desktop/src/main/features/daemon-autostart/daemon-entry.test.ts`
- 修改：`apps/desktop/src/main/features/session/session-service.ts`
- 修改：`apps/desktop/package.json`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：编写 controller 状态与失败收敛测试**

固定公共接口：

```ts
export interface DaemonAutoStartSnapshot {
  configured: boolean
  serviceState: DaemonSystemServiceState
  enabled: boolean
}

export interface DaemonAutoStartController {
  snapshot(): Promise<DaemonAutoStartSnapshot>
  enable(): Promise<DaemonAutoStartSnapshot>
  disable(): Promise<DaemonAutoStartSnapshot>
}

export function createDaemonAutoStartController(options: {
  invocation: DaemonServiceInvocation
}): DaemonAutoStartController

export function shouldStartManagedDaemon(): Promise<boolean>
```

通过依赖注入覆盖：未安装→install、stopped→start、running→不重复操作、disable→uninstall、配置写失败、系统服务写失败、最终状态不一致。失败后再次 snapshot 必须反映真实状态，不能伪造成功。

- [ ] **步骤 2：运行 controller 测试确认入口不存在**

运行：

```powershell
pnpm --filter @vykor/server test -- auto-start-controller
```

预期：FAIL，`@vykor/server/daemon-host` 和 controller 尚不存在。

- [ ] **步骤 3：实现 server 子入口与 controller**

在 package exports 中增加：

```json
"./daemon-host": {
  "import": "./src/daemon-host/index.ts",
  "types": "./src/daemon-host/index.ts"
}
```

`daemon-host/index.ts` 只导出 registry、`startVykorDaemon`、系统服务管理器、autostart controller 和对应类型。根入口不再导出 `DaemonSystemService`，避免本机高权限能力混入普通 server API。

controller 内部使用 core 的 `loadSettings/saveSettings`，按期望状态 reconcile，并在每次操作后重新查询系统服务。系统服务管理器不接受 renderer 输入。

- [ ] **步骤 4：迁移 CLI 与 Desktop**

CLI 工厂继续负责把 CLI entry 解析为 invocation，但 service/controller 均从 daemon-host 导入。CLI 的 install/uninstall 和 ensure 路径使用同一 reconcile 语义。

Desktop `daemon-autostart-service` 只组合：

```text
daemon-host snapshot + Desktop onboarding state
```

Desktop `daemon-entry` 使用 `shouldStartManagedDaemon()`，不再读取 core。`session-service` 的 daemon 启动和 registry 导入切到 daemon-host。删除 Desktop 的 core 依赖。

- [ ] **步骤 5：运行 server、CLI、Desktop 回归**

运行：

```powershell
pnpm --filter @vykor/server test
pnpm --filter @rzx/ohs test -- daemon
pnpm --filter @vykor/desktop test -- daemon-autostart session-service
pnpm --filter @vykor/server check-types
pnpm --filter @rzx/ohs check-types
pnpm --filter @vykor/desktop typecheck
```

预期：全部通过；CLI 与 Desktop 可以互相识别同一系统服务和 `daemon.autoStart`。

- [ ] **步骤 6：提交 daemon-host 边界**

```powershell
git add packages/server/src/daemon-host packages/server/src/daemon packages/server/src/index.ts packages/server/package.json apps/cli/src apps/desktop/src/main/features/daemon-autostart apps/desktop/src/main/features/session/session-service.ts apps/desktop/package.json pnpm-lock.yaml
git commit -m "refactor(server): centralize daemon host lifecycle"
```

## 任务 4：加入边界防回归并修订相关文档

**文件：**
- 创建：`apps/desktop/scripts/verify-workspace-boundaries.mjs`
- 修改：`apps/desktop/package.json`
- 修改：`apps/desktop/docs/packaging.md`
- 修改：`apps/desktop/README.md`
- 修改：`docs/daemon-system-service.md`
- 修改：`docs/superpowers/specs/2026-09-11-desktop-daemon-autostart-design.md`

- [ ] **步骤 1：编写静态边界检查**

脚本扫描 `apps/desktop/src/**/*.{ts,tsx}` 的静态与动态 import：

```js
const allowedWorkspacePackages = new Set([
  "@vykor/client",
  "@vykor/server",
  "@vykor/server/daemon-host",
])
```

另加两条约束：renderer/preload 不得导入任何 server 入口；Desktop package.json 中 `@vykor/*` 只能是 client/server。发现违规时输出文件、包名并以非零状态退出。

- [ ] **步骤 2：先注入一个临时违规 fixture 验证脚本会失败**

在脚本测试数据中传入 `import "@vykor/core"`，预期报告：

```text
Desktop workspace import is not allowed: @vykor/core
```

随后传入 main 的 daemon-host import 和 renderer 的 client type import，预期通过。测试数据留在脚本单元测试中，不创建真实违规源码。

- [ ] **步骤 3：接入检查并更新文档**

将边界脚本接入 Desktop `test` 和 `build`。文档明确：

- Desktop 只直接依赖 client/server；
- client 负责网络协议，daemon-host 负责本地宿主；
- WSL 校验发生在 daemon 主机；
- autostart 不通过 HTTP 暴露；
- electron-vite 的 terminal-node exclude 是传递实现 bundling，不是 Desktop 直接依赖；
- migration 隐藏路径已知，但本次不改。

修订旧 daemon autostart 设计中的主进程职责，改为 Desktop 主进程组合 server controller 与 onboarding，而不是直接管理配置和系统服务。

- [ ] **步骤 4：执行最终验证**

运行：

```powershell
node apps/desktop/scripts/verify-workspace-boundaries.mjs
pnpm --filter @vykor/server test
pnpm --filter @vykor/client test
pnpm --filter @rzx/ohs test
pnpm --filter @vykor/desktop test
pnpm check-types
pnpm --filter @vykor/desktop exec electron-vite build
node apps/desktop/scripts/verify-update-packaging.mjs
rg 'from ["'']@vykor/|require\(["'']@vykor/' apps/desktop/out/main -g '*.js'
git diff --check
```

预期：测试、类型检查、构建和静态检查全部通过；产物扫描无输出。

- [ ] **步骤 5：提交边界检查和文档修订**

```powershell
git add apps/desktop/scripts/verify-workspace-boundaries.mjs apps/desktop/package.json apps/desktop/docs/packaging.md apps/desktop/README.md docs/daemon-system-service.md docs/superpowers/specs/2026-09-11-desktop-daemon-autostart-design.md
git commit -m "docs(desktop): enforce client server dependency boundary"
```

## 最终验收清单

- [ ] Desktop package.json 的 Vykor workspace 依赖只剩 client/server。
- [ ] Desktop 源码不导入 core、sandbox、terminal 或 terminal-node。
- [ ] renderer/preload 不导入 server 或 daemon-host。
- [ ] terminal 类型和所有 terminal 操作从 client 边界取得。
- [ ] WSL 能力探测与保存前校验在 daemon 宿主执行。
- [ ] daemon autostart 在 CLI 与 Desktop 中使用同一个 server controller。
- [ ] daemon 未启动时 watchdog 仍能读取期望状态并正确启动。
- [ ] 系统服务安装与卸载没有暴露成 HTTP API。
- [ ] Desktop 构建产物没有 `@vykor/*` 裸导入。
- [ ] 已知 migration 构建路径保持不变。
- [ ] 相关设计、系统服务、Desktop 与打包文档均与新边界一致。
