# Desktop daemon 常驻设置与首次引导实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Desktop 设置中安全地启停现有 daemon 系统常驻能力，并只为真正首次安装的新用户显示一次侧边栏引导。

**架构：** 把 CLI 中与调用入口无关的系统服务管理器下沉到 `@vykor/server`，CLI 和 Desktop 分别提供自己的 daemon 启动命令。Desktop 主进程维护安装身份、引导状态和真实系统服务快照，通过固定 IPC 暴露给设置页和侧边栏；渲染层只负责交互状态，不执行命令。

**技术栈：** Electron 39、React 19、TypeScript、Vitest、`@vykor/server`、`@vykor/core`、shadcn/ui、Tailwind CSS。

---

## 文件结构

### 共享 daemon 系统服务

- 创建 `packages/server/src/daemon/system-service.ts`：承载 Windows 计划任务、macOS LaunchAgent、Linux systemd user service 的安装、查询、启停实现。
- 修改 `packages/server/src/daemon/index.ts`、`packages/server/src/index.ts`：导出系统服务类型与构造器。
- 修改 `apps/cli/src/daemon-system-service.ts`：只保留 CLI invocation 解析和 `createDaemonSystemService()` 兼容工厂。
- 修改 `apps/cli/src/daemon-system-service.test.ts`：确保 CLI 工厂仍生成原来的命令；共享平台行为测试迁往 server。
- 创建 `packages/server/src/daemon/__test__/system-service.test.ts`：验证三个平台的系统命令和状态映射。

### Desktop 主进程与协议

- 创建 `apps/desktop/src/main/features/daemon-autostart/daemon-entry.ts`：处理打包应用的 `--daemon-service` 与 Windows `--daemon-watchdog` 无界面入口。
- 创建 `apps/desktop/src/main/features/daemon-autostart/daemon-entry.test.ts`：验证入口选择、已有健康 daemon 等待/退出以及 watchdog 拉起规则。
- 创建 `apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.ts`：组合全局配置、系统服务、首次安装识别和引导状态。
- 创建 `apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.test.ts`：覆盖新老用户、启停、失败和真实状态。
- 创建 `apps/desktop/src/main/features/daemon-autostart/ipc.ts`：注册固定 IPC。
- 修改 `apps/desktop/src/main/features/index.ts`、`apps/desktop/src/main/index.ts`：注册 IPC，并在创建窗口前分流无界面 daemon 入口。
- 修改 `apps/desktop/src/main/features/settings/desktop-preferences.ts` 及测试：保存安装身份和引导枚举。
- 修改 `apps/desktop/src/shared/settings-types.ts`：定义统一快照和操作输入。
- 修改 `apps/desktop/src/shared/ipc-channels.ts`、`desktop-api-contract.ts`、`apps/desktop/src/preload/desktop-api.ts` 及 preload 测试：贯通类型安全接口。
- 修改 `apps/desktop/package.json`、`pnpm-lock.yaml`：声明 Desktop 对 `@vykor/core` 的直接依赖。

### Desktop 渲染界面

- 创建 `apps/desktop/src/renderer/src/components/desktop/settings-page/daemon-autostart-control.tsx` 及测试：设置页开关、聚焦刷新、错误回滚。
- 创建 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/daemon-autostart-card.tsx` 及测试：首次引导卡、开启、暂不开启、失败重试。
- 修改 `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`：插入设置项。
- 修改 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`：替换并最终移除静态「开始使用」占位。
- 修改 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts`：删除对旧占位的断言并保持既有场景测试有效。

### 文档与打包验证

- 修改 `docs/daemon-system-service.md`、`apps/desktop/README.md`：记录 Desktop 入口、状态含义和首次引导。
- 修改 `apps/desktop/scripts/verify-update-packaging.mjs`：确认打包产物包含 Desktop daemon 入口所需模块。

## 任务 1：下沉可复用的系统服务管理器

**文件：**
- 创建：`packages/server/src/daemon/system-service.ts`
- 创建：`packages/server/src/daemon/__test__/system-service.test.ts`
- 修改：`packages/server/src/daemon/index.ts`
- 修改：`packages/server/src/index.ts`
- 修改：`apps/cli/src/daemon-system-service.ts`
- 修改：`apps/cli/src/daemon-system-service.test.ts`

- [ ] **步骤 1：先为共享导出和平台行为编写失败测试**

在 server 测试中直接实例化共享类，注入 `runCommand`，至少断言：

```ts
const service = new DaemonSystemService({
  invocation: { command: "Vykor", args: ["--daemon-service"], cwd: "D:/app" },
  platform: "win32",
  homeDir: "D:/home",
  logsDir: "D:/logs",
  runCommand,
})

service.install()
expect(runCommand).toHaveBeenCalledWith(
  "powershell.exe",
  expect.arrayContaining(["-NonInteractive"]),
  expect.objectContaining({ VK_WORKING_DIRECTORY: "D:/app" })
)
```

同时保留 CLI 工厂测试，断言 TypeScript 开发入口仍通过 `node --import tsx <entry> daemon watchdog ...`，发布入口仍使用当前 Node 可执行文件。

- [ ] **步骤 2：运行测试并确认共享导出尚不存在**

运行：

```powershell
pnpm --filter @vykor/server test -- system-service
pnpm --filter @rzx/ohs test -- daemon-system-service
```

预期：server 测试因 `DaemonSystemService` 尚未从 server daemon 模块导出而失败；CLI 既有测试仍通过。

- [ ] **步骤 3：移动平台实现并保留 CLI 薄工厂**

把 `DaemonSystemService`、状态类型、命令结果类型和引号辅助函数移入 server。共享类继续只接受已经解析好的 invocation：

```ts
export interface DaemonServiceInvocation {
  command: string
  args: string[]
  cwd: string
}

export class DaemonSystemService {
  constructor(private readonly options: DaemonSystemServiceOptions) {}
  status(): DaemonSystemServiceStatus
  install(): void
  uninstall(): void
  start(): void
  stop(): void
}
```

CLI 文件从 `@vykor/server` 导入共享类，只负责调用 `resolveDaemonInvocation()` 并构造实例。不要改变计划任务名、LaunchAgent label、systemd unit 名或现有命令行为。

- [ ] **步骤 4：运行共享与 CLI 回归测试**

运行：

```powershell
pnpm --filter @vykor/server test -- system-service
pnpm --filter @rzx/ohs test -- daemon-system-service daemon-auto-start ensure-daemon
pnpm --filter @vykor/server check-types
pnpm --filter @rzx/ohs check-types
```

预期：全部通过，CLI 的 `daemon install/status/start/stop/uninstall` 行为未变化。

- [ ] **步骤 5：提交共享能力**

```powershell
git add packages/server/src/daemon apps/cli/src/daemon-system-service.ts apps/cli/src/daemon-system-service.test.ts
git commit -m "refactor(server): share daemon system service manager"
```

## 任务 2：让打包 Desktop 提供无界面 daemon 入口

**文件：**
- 创建：`apps/desktop/src/main/features/daemon-autostart/daemon-entry.ts`
- 创建：`apps/desktop/src/main/features/daemon-autostart/daemon-entry.test.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/package.json`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：编写入口解析和生命周期失败测试**

将进程判断写成无 Electron UI 依赖的纯函数，并注入 registry/health/start 依赖：

```ts
expect(resolveDesktopDaemonMode(["Vykor", "--daemon-service"])).toBe("service")
expect(resolveDesktopDaemonMode(["Vykor", "--daemon-watchdog"])).toBe("watchdog")
expect(resolveDesktopDaemonMode(["Vykor"])).toBeNull()
```

测试 `service` 模式在 registry 健康时等待现有进程结束，registry 失效后调用 `startVykorDaemon()` 并保持进程存活；测试 `watchdog` 模式在健康时直接成功退出，在不健康且 `daemon.autoStart` 为真时派生隐藏的 `--daemon-service`，为假时不启动。

- [ ] **步骤 2：运行测试确认入口不存在**

运行：

```powershell
pnpm --filter @vykor/desktop test -- daemon-entry
```

预期：FAIL，提示无法导入 `daemon-entry`。

- [ ] **步骤 3：实现最小无界面入口**

实现以下固定入口：

```ts
export type DesktopDaemonMode = "service" | "watchdog"

export function resolveDesktopDaemonMode(argv: readonly string[]): DesktopDaemonMode | null
export async function runDesktopDaemonEntry(mode: DesktopDaemonMode): Promise<void>
```

`main/index.ts` 必须先解析模式，再申请单实例锁或创建窗口：

```ts
const daemonMode = resolveDesktopDaemonMode(process.argv)
if (daemonMode) {
  void runDesktopDaemonEntry(daemonMode).catch(reportFatalDaemonError)
} else {
  startDesktopApplication()
}
```

`service` 复用 `startVykorDaemon()`、registry 和信号关闭流程。Windows `watchdog` 只做一次健康检查并按需派生隐藏 service 进程，随后退出，以匹配现有每分钟计划任务语义。macOS/Linux 的系统服务直接运行 `--daemon-service`。

Desktop 增加 `@vykor/core: workspace:*` 直接依赖，用于读写 `daemon.autoStart`，不要依赖 `apps/cli`。

- [ ] **步骤 4：验证入口测试、类型和普通 UI 启动分支**

运行：

```powershell
pnpm --filter @vykor/desktop test -- daemon-entry
pnpm --filter @vykor/desktop typecheck:node
```

预期：全部通过；普通 argv 仍进入现有窗口初始化，daemon argv 不创建窗口、托盘、宠物或 updater。

- [ ] **步骤 5：提交 Desktop daemon 入口**

```powershell
git add apps/desktop/src/main/index.ts apps/desktop/src/main/features/daemon-autostart/daemon-entry.ts apps/desktop/src/main/features/daemon-autostart/daemon-entry.test.ts apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(desktop): add headless daemon service entry"
```

## 任务 3：实现主进程常驻状态和首次安装状态机

**文件：**
- 创建：`apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.ts`
- 创建：`apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.test.ts`
- 修改：`apps/desktop/src/main/features/settings/desktop-preferences.ts`
- 修改：`apps/desktop/src/main/features/settings/desktop-preferences.test.ts`
- 修改：`apps/desktop/src/shared/settings-types.ts`

- [ ] **步骤 1：为偏好迁移和统一快照编写失败测试**

定义并固定协议：

```ts
export type DesktopDaemonOnboardingState = "pending" | "enabled" | "dismissed"
export type DesktopInstallIdentity = "new" | "existing"

export interface DesktopDaemonAutoStartSnapshot {
  configured: boolean
  serviceState: "not-installed" | "stopped" | "running" | "unknown"
  enabled: boolean
  onboardingState: DesktopDaemonOnboardingState
  showOnboarding: boolean
}
```

测试没有偏好文件、且 userData 中没有任何旧 Desktop 文件时初始化为 `new/pending`；已有旧偏好、窗口状态或其他明确 Desktop 数据时初始化为 `existing/dismissed`。迁移检查必须在写新偏好文件前完成。

服务测试注入 `loadSettings/saveSettings/systemService`：配置为真且服务 running 时 `enabled=true`；配置为真但服务 not-installed 时 `enabled=false`；开启失败时不写 `enabled`；dismiss 后永久保持 `dismissed`。

- [ ] **步骤 2：运行测试确认类型和服务尚不存在**

运行：

```powershell
pnpm --filter @vykor/desktop test -- desktop-preferences daemon-autostart-service
```

预期：FAIL，缺少新枚举、迁移函数和 service。

- [ ] **步骤 3：扩展偏好文件并实现状态服务**

偏好文件新增字段时保留现有通知和 opener 字段：

```ts
export interface DesktopPreferences {
  notificationMode: DesktopNotificationMode
  installIdentity?: DesktopInstallIdentity
  daemonOnboardingState?: DesktopDaemonOnboardingState
  defaultOpenerId?: string
  defaultTerminalShellId?: string
}
```

`DaemonAutoStartService.snapshot()` 同时读取 `loadSettings().daemon.autoStart` 和 `systemService.status()`。`enable()` 顺序为保存配置、安装/启动、重新查询、确认真实启用，最后才把 onboarding 写成 `enabled`。失败时尽力恢复原配置并重新查询后抛错。`disable()` 卸载服务并保存 false，不修改 onboarding 状态。`dismissOnboarding()` 只允许把 `pending` 写成 `dismissed`。

Desktop invocation 固定为：Windows `process.execPath --daemon-watchdog`，macOS/Linux `process.execPath --daemon-service`；cwd 使用 `dirname(process.execPath)`，不接受渲染层输入。

- [ ] **步骤 4：运行状态机和既有偏好回归测试**

运行：

```powershell
pnpm --filter @vykor/desktop test -- desktop-preferences daemon-autostart-service
pnpm --filter @vykor/desktop typecheck:node
```

预期：全部通过，旧偏好字段不会在 patch 时丢失。

- [ ] **步骤 5：提交主进程状态机**

```powershell
git add apps/desktop/src/main/features/daemon-autostart apps/desktop/src/main/features/settings/desktop-preferences.ts apps/desktop/src/main/features/settings/desktop-preferences.test.ts apps/desktop/src/shared/settings-types.ts
git commit -m "feat(desktop): manage daemon autostart state"
```

## 任务 4：通过固定 IPC 暴露常驻操作

**文件：**
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`
- 修改：`apps/desktop/src/preload/desktop-api.test.ts`
- 创建：`apps/desktop/src/main/features/daemon-autostart/ipc.ts`
- 修改：`apps/desktop/src/main/features/index.ts`

- [ ] **步骤 1：编写 preload 和 IPC 失败测试**

期望 API 只有四个无参数动作：

```ts
daemonAutoStart: {
  snapshot: () => Promise<DesktopDaemonAutoStartSnapshot>
  enable: () => Promise<DesktopDaemonAutoStartSnapshot>
  disable: () => Promise<DesktopDaemonAutoStartSnapshot>
  dismissOnboarding: () => Promise<DesktopDaemonAutoStartSnapshot>
}
```

测试每个方法映射到唯一 channel；IPC contribution 只调用 service 固定方法，不把 event 参数或任意字符串传给系统层。

- [ ] **步骤 2：运行测试确认协议尚未接线**

运行：

```powershell
pnpm --filter @vykor/desktop test -- desktop-api daemon-autostart/ipc
```

预期：FAIL，`daemonAutoStart` 和对应 channels 不存在。

- [ ] **步骤 3：实现类型、preload 和 IPC contribution**

添加 `daemon-autostart:snapshot|enable|disable|dismiss-onboarding` 四个 invoke channel，更新 `IpcInvokeMap`、`DesktopAPI` 和 preload。将 contribution 注册到 `allIpcContributions`，保持错误由现有 `wrapIpcHandler` 统一序列化。

- [ ] **步骤 4：运行 IPC、preload 与类型检查**

运行：

```powershell
pnpm --filter @vykor/desktop test -- desktop-api daemon-autostart
pnpm --filter @vykor/desktop typecheck
```

预期：全部通过，渲染层不能传入 executable、args、cwd 或 service 名称。

- [ ] **步骤 5：提交 IPC 接线**

```powershell
git add apps/desktop/src/shared apps/desktop/src/preload apps/desktop/src/main/features/daemon-autostart/ipc.ts apps/desktop/src/main/features/index.ts
git commit -m "feat(desktop): expose daemon autostart controls"
```

## 任务 5：在设置页加入真实状态开关

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/daemon-autostart-control.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/daemon-autostart-control.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`

- [ ] **步骤 1：编写设置控件交互失败测试**

测试初次 mount 调用 snapshot；`enabled` 决定开关；点击开启/关闭期间 switch disabled；失败后再次 snapshot 并显示 `role="alert"`；窗口 `focus` 时刷新：

```ts
expect(snapshot).toHaveBeenCalledTimes(1)
window.dispatchEvent(new Event("focus"))
expect(snapshot).toHaveBeenCalledTimes(2)
```

- [ ] **步骤 2：运行测试确认控件不存在**

运行：

```powershell
pnpm --filter @vykor/desktop test -- daemon-autostart-control
```

预期：FAIL，无法导入控件。

- [ ] **步骤 3：实现控件并插入常规设置**

组件内部维护 `snapshot/loading/saving/error`。开关使用真实 `snapshot.enabled`，而不是只看 `configured`。在 `GeneralSettings` 的通知设置附近加入：

```tsx
<SettingRow
  title="后台持续运行"
  description="登录系统后自动启动 daemon，并在异常退出后恢复，让定时任务和后台工作持续执行。"
  control={<DaemonAutoStartControl />}
/>
```

未知或读取失败时禁用开关并显示错误；不要把失败状态渲染成关闭成功。

- [ ] **步骤 4：运行控件、设置页和 Web 类型检查**

运行：

```powershell
pnpm --filter @vykor/desktop test -- daemon-autostart-control settings
pnpm --filter @vykor/desktop typecheck:web
```

预期：全部通过。

- [ ] **步骤 5：提交设置界面**

```powershell
git add apps/desktop/src/renderer/src/components/desktop/settings-page
git commit -m "feat(desktop): add daemon autostart setting"
```

## 任务 6：用一次性引导替换侧边栏占位

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/daemon-autostart-card.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/daemon-autostart-card.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts`

- [ ] **步骤 1：编写展示矩阵与操作失败测试**

用参数化测试固定展示条件：

```ts
it.each([
  [{ showOnboarding: true }, true],
  [{ showOnboarding: false }, false],
])("renders only when snapshot permits it", async (snapshot, visible) => {
  // mock snapshot, render, assert title presence equals visible
})
```

另测：点击「暂不开启」调用 dismiss 并立即消失；点击「开启」显示处理中，成功后消失；失败后保留卡片、显示 `role="alert"` 和「重试」；初次 snapshot resolve 前不渲染，避免闪现。

- [ ] **步骤 2：运行测试确认新卡片不存在**

运行：

```powershell
pnpm --filter @vykor/desktop test -- daemon-autostart-card main-layout-project-operation-error
```

预期：FAIL，新组件不存在；旧测试仍能找到静态「开始使用」。

- [ ] **步骤 3：实现紧凑卡片并删除静态占位**

卡片放在侧边栏滚动区和底部设置栏之间原来的 `px-2 py-2` 容器中，使用现有 Button、Spinner 和 sidebar token：

```tsx
<section aria-label="保持后台运行" className="rounded-md bg-background p-3 shadow-sm ring-1 ring-black/5">
  <h2 className="text-ui-small font-medium">保持后台运行</h2>
  <p className="mt-1 text-xs leading-5 text-sidebar-muted">
    关闭 Vykor 后，定时任务和后台工作仍可继续。
  </p>
  {/* 开启 / 暂不开启，失败时显示重试 */}
</section>
```

删除 `CircleDot` 和「开始使用 1/3」静态按钮。操作成功或 dismiss 后设置本地 snapshot 为返回值，让区域立即消失；不要恢复旧占位。

- [ ] **步骤 4：运行侧边栏测试和可访问性检查**

运行：

```powershell
pnpm --filter @vykor/desktop test -- daemon-autostart-card main-layout sidebar
pnpm --filter @vykor/desktop typecheck:web
```

预期：全部通过；按钮有明确可访问名称，错误使用 `role="alert"`，加载不抢焦点。

- [ ] **步骤 5：提交首次引导界面**

```powershell
git add apps/desktop/src/renderer/src/components/desktop/layout/main-layout
git commit -m "feat(desktop): add one-time daemon onboarding"
```

## 任务 7：补齐真实状态转换、文档和打包验证

**文件：**
- 修改：`apps/desktop/src/main/features/daemon-autostart/daemon-entry.test.ts`
- 修改：`apps/desktop/src/main/features/daemon-autostart/daemon-autostart-service.test.ts`
- 修改：`apps/desktop/scripts/verify-update-packaging.mjs`
- 修改：`docs/daemon-system-service.md`
- 修改：`apps/desktop/README.md`

- [ ] **步骤 1：增加 Desktop 内嵌 daemon 到系统 daemon 的转换测试**

构造 registry 指向当前 Desktop PID 的场景：启用常驻后，service 进程在当前 registry 健康期间不得启动第二个 server；Desktop 退出并清理 registry 后，它必须取得 registry 并启动。再覆盖外部 CLI daemon 已健康时，Desktop 只安装启动配置，不替换健康 daemon。

- [ ] **步骤 2：运行测试验证转换用例**

运行：

```powershell
pnpm --filter @vykor/desktop test -- daemon-entry daemon-autostart-service
```

预期：如果任务 2 的等待/接管逻辑遗漏竞态，本步骤先失败；修复后通过，任一时刻只有一个 registry owner。

- [ ] **步骤 3：更新文档和打包检查**

在 daemon 文档中加入 Desktop executable 的两种无界面模式、Windows watchdog 与 macOS/Linux service 的差异、设置页与 CLI 的同源配置。Desktop README 记录新用户判断和引导状态位置。

扩展打包检查：构建后的 `out/main/index.js` 必须包含 `--daemon-service`、`--daemon-watchdog` 和系统服务入口引用；确保普通启动分支仍存在。

- [ ] **步骤 4：执行完整验证**

运行：

```powershell
pnpm --filter @vykor/server test
pnpm --filter @rzx/ohs test
pnpm --filter @vykor/desktop test
pnpm --filter @vykor/desktop build
pnpm --filter @vykor/desktop verify:update-packaging
pnpm check-types
```

预期：所有测试、Desktop 构建、打包静态检查和全仓类型检查通过。手工用 unpacked 应用验证设置开关、侧边栏首次引导、关闭窗口后的 daemon 存活，以及关闭常驻后用户数据保留。

- [ ] **步骤 5：提交文档与最终验证补充**

```powershell
git add apps/desktop/src/main/features/daemon-autostart apps/desktop/scripts/verify-update-packaging.mjs docs/daemon-system-service.md apps/desktop/README.md
git commit -m "docs(desktop): document daemon autostart flow"
```

## 最终验收清单

- [ ] 新用户首次启动、常驻关闭时只看到一次侧边栏引导。
- [ ] 老用户升级、保留数据重装、已开启常驻时不显示引导。
- [ ] 「暂不开启」后区域永久消失，旧「开始使用 1/3」不恢复。
- [ ] 引导和设置页开启均安装服务、启动 daemon，并以重新读取的真实状态为准。
- [ ] 设置页关闭会停止并卸载服务、写入 false，但不删除业务数据或重置引导。
- [ ] CLI 修改后 Desktop 聚焦或重进设置页能看到新状态。
- [ ] Desktop 内嵌 daemon 与系统 daemon 不会并发争抢 registry。
- [ ] daemon 模式不创建窗口、托盘、宠物或 updater。
- [ ] Windows、macOS、Linux 使用现有用户级系统服务语义。
- [ ] 全仓类型检查、相关测试和 Desktop 构建全部通过。
