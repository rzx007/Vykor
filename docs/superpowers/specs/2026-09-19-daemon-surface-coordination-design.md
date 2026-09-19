# Daemon 启动模式标记与桌面端接管设计

> 状态：待实现。

## 目标

桌面端启动时，确保连接的本地 daemon 以桌面模式（`executionSurface: "desktop_managed"`）运行，从而保证桌面「环境终端」等功能可用；同时保留「任意入口有存活 daemon 就复用」的通用行为，不新增第二套后台进程或自启机制。

## 背景

- 桌面终端固定请求环境终端（`apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-runtime-model.ts:9` → `runtime: "environment"`）。
- daemon 仅在 `executionSurface === "desktop_managed"` 时创建环境获取器（`packages/server/src/application/daemon-application.ts:295-299`）；否则创建终端返回 503（`packages/server/src/terminal/daemon-terminal-service.ts:183-186`）。
- CLI 的 `serve` 不传该参数（`apps/cli/src/commands/daemon.ts:62-69`），因此 `ohs`、`ohs daemon start`、`ohs channels serve` 启动的 daemon 不支持环境终端。
- 桌面连接逻辑只校验 `/health` 与 `/projects.list`，不区分启动模式就复用（`apps/desktop/src/main/features/session/daemon-connection-service.ts:93-99`）。
- registry 无启动模式字段（`packages/server/src/daemon/paths.ts:7-14`），桌面无法判断当前 daemon 是否可用。
- 另外，桌面服务模式 daemon 未传 `outsideProjectWorkspaceRoot`（`apps/desktop/src/main/features/daemon-autostart/daemon-entry.ts:40-46`），项目外定时任务会落到兜底目录（`packages/server/src/application/schedule/scheduled-task-executor.ts:104-110`），与桌面 UI 识别的文档目录不一致。

## 术语

- **桌面托管 daemon**：`registry.executionSurface === "desktop_managed"` 的本地 daemon，支持环境终端。
- **CLI daemon**：`executionSurface === "cli_advanced"` 或该字段缺失的本地 daemon，支持本机终端但不支持环境终端。
- **registry**：`~/.openharness-ts/data/daemon/registry.json`。

## 设计决策

采用「桌面端按启动模式接管」方案，而不是「始终启用环境获取器」。原因：环境获取器同时会交给 Agent 加载器（`packages/server/src/daemon/daemon-agent.ts:148-156`），在 CLI 上启用会让 CLI Agent 也走沙箱环境，改变 CLI 语义。保持能力边界不变，只在桌面侧保证连到合适的 daemon。

## 行为规格

### 1. registry 记录启动模式

`DaemonRegistry` 增加可选字段：

```ts
executionSurface?: "desktop_managed" | "cli_advanced";
```

- 桌面内置 daemon（`daemon-connection-service.ts`）与桌面服务 daemon（`daemon-entry.ts`）写入 `"desktop_managed"`。
- CLI `serve`（`apps/cli/src/commands/daemon.ts` 的 `runServe()`）写入 `"cli_advanced"`。只改 registry 载荷，不给 `startOpenHarnessDaemon` 传该参数，CLI daemon 的运行语义保持不变。
- 旧 registry 缺此字段时，桌面视为 CLI daemon。

### 2. CLI 入口行为（保持复用）

`ohs`、`ohs daemon start`、`ohs channels serve` 继续沿用现有 `ensureLocalDaemon` / `daemon start` 逻辑：有 ready daemon 就复用，不因启动模式不同而重启。本设计不改变 CLI 行为。

### 3. 桌面连接决策

桌面 `DaemonConnectionService.connect()`：

1. 无 registry → 启动内置 daemon。
2. registry 存在且校验（`/health` + `/projects.list`）成功：
   - `executionSurface === "desktop_managed"` → 直接复用。
   - 否则：
     - `daemon.autoStart` 为 `false` → 停止该 daemon，等待退出，清空 registry，启动内置 daemon。
     - `daemon.autoStart` 为 `true` → 把系统服务重协调为桌面启动入口，等待桌面托管 registry 就绪，再连接（不另起内置 daemon）。

> `daemon.autoStart` 指桌面设置偏好，通过 `shouldStartManagedDaemon()`（`loadSettings().daemon?.autoStart`，见 `packages/server/src/daemon-host/auto-start-controller.ts:102-104`）读取，并由注入的 `shouldAutoStart()` 提供；**不是 registry 字段**，也不在本次新增的 registry 字段范围内。
3. registry 存在但校验失败：
   - pid 仍存活 → 保持现状抛错，不强占（避免与活着的 owner 抢同一会话库的 owner lease）。
   - pid 已死 → 清空 registry，启动内置 daemon。

### 4. 停止 CLI daemon 的规则

`stopNonDesktopDaemon(pid, url)`：

1. 仅当 registry url 为 loopback（`127.0.0.1` / `localhost` / `::1`）时执行；非 loopback 直接报错，不杀进程。
2. 发 SIGTERM；轮询最多 5 秒等待进程退出。
3. 仍未退出 → 强制结束（SIGKILL / TerminateProcess），再等最多 2 秒。
4. 仍存活 → 抛错，不继续启动，避免两个 daemon 同时占用同一会话库。

### 5. autoStart 开启时的服务重协调

`reconcileDesktopService(registry)`：

1. 卸载当前系统服务（可能是 CLI 入口或旧桌面入口）。
2. 停止 registry 中残留的 CLI 进程（覆盖 detached `serve` 子进程：卸载计划任务不会自动杀掉它）。
3. 清空 registry。
4. 安装桌面系统服务（Windows `--daemon-watchdog`，macOS/Linux `--daemon-service`）并启动。
5. 轮询最多 15 秒，等待 registry ready 且 `executionSurface === "desktop_managed"`，然后连接。
6. 任一步失败 → 返回错误状态，不退回内置 daemon（避免与服务互相争抢）。

### 6. 桌面服务/watchdog 的接管判定

`daemon-entry.ts` 的 `registeredDaemonHealthy()` 增加条件：registry 的 `executionSurface` 必须为 `"desktop_managed"`，否则视为不可复用。

当桌面服务 daemon（由 watchdog 拉起，或由 macOS/Linux 系统服务直接托管）判定需要接管时，若 registry 指向一个仍存活的 CLI daemon，**必须先终止该进程并等待退出**（复用 §4 同一 helper，同样仅限 loopback：SIGTERM → 5 秒 → 强制结束），再清空 registry 并启动。否则仅清空 registry 不会释放会话库的 owner lease（`packages/services/src/session-runtime/store.ts`），新 daemon 会在 `acquireApplicationOwner` 的 `canTakeOver`（`packages/server/src/application/daemon-application.ts:216`）处抛 `ApplicationOwnerConflictError`，接管失败。

### 7. 项目外工作区根修复

桌面服务模式启动 daemon 时补齐：

```ts
outsideProjectWorkspaceRoot: buildOutsideProjectRoot(app.getPath("documents")),
```

与内置 daemon（`daemon-connection-service.ts:134`）保持一致。

## 组件边界与数据流

涉及文件：

- `packages/server/src/daemon/paths.ts`：registry 结构与读写。
- `packages/server/src/daemon-host/lifecycle.ts`（新增）：`daemonPidAlive`、`terminateDaemonProcess`、`forceKillDaemonProcess`、`waitForProcessExit`，由 CLI 与桌面共用。
- `packages/server/src/daemon-host/index.ts`：导出上述工具。
- `apps/cli/src/daemon-lifecycle.ts`：改为复用上述实现（移除本地的 `daemonPidAlive`、`terminateDaemonProcess`；保留 `probeDaemonRegistry`）。
- `apps/cli/src/commands/daemon.ts`：迁移其私有 `waitForProcessExit`（约 428-434 行）到共享工具；registry 写入 `executionSurface: "cli_advanced"`。
- `apps/desktop/src/main/features/session/daemon-connection-service.ts`：连接决策、接管与重协调。为可测试性，构造参数注入 `shouldAutoStart()`、`stopNonDesktopDaemon()`、`reconcileDesktopService()`。
- `apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.ts`：新增 `createDesktopDaemonSystemService()`，供连接层安装/卸载桌面服务。
- `apps/desktop/src/main/features/daemon-autostart/daemon-entry.ts`：surface 感知健康检查；接管前终止存活 CLI 进程；服务模式补齐 `outsideProjectWorkspaceRoot`；registry 写入 `executionSurface`。

共享 `daemonPidAlive` 的存活语义统一为「能发信号或 `EPERM` 均视为存活」（采用桌面现有 `isPidAlive` 语义，`daemon-connection-service.ts:192-201`）。CLI 原实现在 `EPERM` 时返回 false（`apps/cli/src/daemon-lifecycle.ts:14-21`），迁移后 `probeDaemonRegistry` 会对 EPERM 进程继续请求 `/health`，而不是直接判定不可达。这是有意的行为变化，需补一条回归测试。

数据流（autoStart 关闭）：

```text
Desktop 启动
  → 读取 registry
  → 校验健康
  → 非桌面托管
  → SIGTERM 旧 daemon
  → 等待 / 强制结束
  → 清空 registry
  → 启动内置 daemon（desktop_managed）
  → 写入 registry
  → 连接
```

数据流（autoStart 开启）：

```text
Desktop 启动
  → 读取 registry
  → 校验健康
  → 非桌面托管
  → 卸载旧系统服务
  → 杀掉残留进程
  → 清空 registry
  → 安装桌面系统服务
  → 服务启动 desktop_managed daemon
  → 写入 registry
  → 轮询就绪
  → 连接
```

## 状态、错误与安全

- 接管期间 daemon 状态对渲染层可见，复用现有 `DesktopDaemonStatusPhase`（`idle` / `discovering` / `connecting` / `starting` / `ready` / `error`）：`connecting` → `starting` → `ready`；失败进入 `error`，且不缓存 rejection，用户可重试。不新增状态枚举。
- 只在 loopback registry 上终止进程；无法确认的远程/非本机 daemon 不处理，直接报错。
- 不读取渲染层传入的 pid 或路径；终止目标只来自本地 registry。
- 强制结束是最后手段：默认先 SIGTERM 并给 5 秒优雅退出窗口。
- 接管会中断旧 daemon 上正在运行的会话；该动作只发生在桌面连接阶段，属于预期行为。
- 本设计不新增 HTTP API、不改变 daemon 运行模型、不改变 SessionStore 与 Scheduled Tasks 语义。

## 测试与验收

自动化测试至少覆盖：

- registry 含 `executionSurface` 的读写，以及旧格式（缺字段）兼容。
- 桌面托管 daemon 健康 → 复用，不启动内置。
- CLI daemon 健康 + autoStart 关 → 停进程、清 registry、启动内置；写入的 registry 为 `desktop_managed`。
- CLI daemon 健康 + autoStart 开 → 调用服务卸载/安装、等待就绪、不启动内置。
- 非 loopback registry → 不终止、报错。
- 进程 5 秒未退出 → 调用强制结束。
- pid 存活但不可达 → 保持抛错、不清 registry、不启动内置（现有回归用例）。
- `registeredDaemonHealthy()` 在 `cli_advanced` registry 下返回 false。
- 桌面服务接管时若存在存活 CLI daemon → 先终止（复用 §4）再启动，不因 owner lease 冲突失败。
- 共享 `daemonPidAlive` 在 `EPERM` 时返回 true；`probeDaemonRegistry` 对该情形继续请求 `/health`。
- 服务模式写入 registry 含 `executionSurface`；`startOpenHarnessDaemon` 收到 `outsideProjectWorkspaceRoot`。

人工验收：

- 先用 `ohs daemon start` 启动 daemon，再打开桌面 App：终端可用，daemon 变为 desktop_managed。
- 开启「后台持续运行」后重复上述场景：服务被替换为桌面入口，终端可用。
- 桌面 daemon 存活时执行 `ohs`：直接复用，不重启。

## 不在范围内

- 远程 daemon 的启动模式协调。
- 让 CLI daemon 直接支持环境终端（会改变 CLI Agent 语义）。
- 版本不匹配时的接管策略（本次只按启动模式判断）。
- 修改 daemon 的任务恢复语义。
