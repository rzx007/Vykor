# Desktop client/server 依赖边界收敛设计

## 目标

将 `apps/desktop` 对 Vykor workspace 包的直接依赖长期收敛为：

```json
{
  "@vykor/client": "workspace:*",
  "@vykor/server": "workspace:*"
}
```

这次收敛改善的是源码依赖方向和职责边界。`core`、`sandbox`、`terminal-node` 等实现仍可能作为 server 的传递依赖进入 Desktop 主进程 bundle，不以减小安装包体积为主要目标。

## 边界定义

### `@vykor/client`

负责所有通过 daemon HTTP/SSE 完成的操作，以及 Desktop 使用的客户端协议类型，包括：

- session、project、settings 和 provider 操作；
- terminal 创建、读写、调整、关闭和事件流；
- daemon 对外公开的能力探测；
- renderer/shared 层需要引用的数据类型。

### `@vykor/server`

负责 Electron 主进程需要的本机 daemon 宿主能力，包括：

- 启动内嵌 daemon；
- daemon registry；
- Desktop 无界面 daemon 入口；
- 系统服务安装、启动、查询和卸载；
- `daemon.autoStart` 的期望状态、协调、失败恢复与最终复核。

本机宿主能力通过 `@vykor/server/daemon-host` 子路径公开，不继续向 server 根入口堆叠。该子路径只供 CLI 和 Desktop 主进程使用，不是 HTTP API，也不能被 renderer 或 preload 导入。

## 目标依赖方向

```text
Desktop Renderer / Preload
        │ IPC
        ▼
Desktop Main
   ├── @vykor/client
   │      HTTP、SSE、Terminal、Settings、协议类型
   │
   └── @vykor/server/daemon-host
          registry、内嵌 daemon、系统服务、autostart reconcile
                    │
                    ├── core
                    ├── sandbox
                    ├── terminal-node
                    └── 其他 server 内部实现
```

必须保持以下方向：

```text
client -> protocol
server -> core / sandbox / terminal-node / protocol
desktop -> client + server
```

禁止 `server -> client`，也禁止为了方便把 server 本地宿主类型放进 client。

## `terminal` 与 `terminal-node` 收敛

Desktop 当前对 `@vykor/terminal` 只有类型导入，实际终端操作均通过 `VykorClient`。由于 client 已公开相同终端协议类型，Desktop 的 `terminal-types.ts` 和 `terminal-service.ts` 改为从 `@vykor/client` 导入。

完成后删除 Desktop 对 `@vykor/terminal` 的直接声明。

Desktop 源码没有导入 `@vykor/terminal-node`。它是 server 的运行时依赖，因此删除 Desktop 对它的直接声明。

`electron.vite.config.ts` 中 `externalizeDeps.exclude` 的 `terminal` 和 `terminal-node` 暂时保留。这里控制 server 传递实现是否打进主进程 bundle，与 Desktop 是否拥有直接源码依赖不是同一件事。删除 package 声明后必须通过真实构建和产物扫描确认不存在未打包的 `@vykor/*` 裸导入。

## `sandbox` 收敛

Desktop 当前只为切换 WSL 运行环境直接调用 `preflightWsl()`。该检查应归 daemon 执行宿主，而不是 Desktop UI 宿主。

目标流程：

```text
Desktop
  -> client.patchSettings({ agentEnvironment: { kind: "wsl" } })
  -> daemon settings service 校验输入
  -> daemon 所在机器执行 WSL preflight
  -> 成功后保存设置并要求 runtime restart
  -> 失败则保持旧设置，通过 client 返回结构化错误
```

通用 settings service 接受注入的 `validateAgentEnvironment` 能力；默认 daemon composition 注入 sandbox 的真实实现。不要在通用 settings service 中硬编码 Desktop UI 逻辑。

Desktop 删除 `preflightWsl`、`process.platform` 拒绝逻辑和 `@vykor/sandbox` 依赖。界面继续展示 server 返回的错误。

当前 Desktop 只连接本机 registry 或启动本机内嵌 daemon，所以现有本机预检没有产生跨主机错误。迁移的价值是职责归属正确，并为未来远程 daemon 做准备。

`wslSupported` 由 daemon capability/probe 返回，而不是由 Desktop 的 `process.platform === "win32"` 推断。公开 capabilities 使用短时缓存和并发合并，避免每次免认证请求都派生一个 WSL 探测进程；真正保存 WSL 设置前仍执行实时校验。

## `core` 与 daemon-host 收敛

Desktop 直接使用 `core` 是为了读取、保存 `daemon.autoStart`，以及在 Windows watchdog 启动前判断期望状态。这些能力在 daemon 未启动时也必须可用，因此不能只通过 client/HTTP 提供。

在 server 中建立 `daemon-host` 子入口，导出窄接口：

```ts
export interface DaemonAutoStartSnapshot {
  configured: boolean
  serviceState: "not-installed" | "stopped" | "running" | "unknown"
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

controller 内部负责：

- 读取和保存 `daemon.autoStart`；
- 查询系统服务真实状态；
- install、start 和 uninstall；
- 配置写入或系统服务操作失败后的恢复；
- 操作完成后的真实状态复核。

Desktop 只组装 Electron invocation：`command`、固定 args 和 cwd。首次安装身份与一次性引导仍属于 Desktop 产品体验，继续保存在 Desktop preferences，不进入 server。

CLI 的 `daemon install/uninstall`、`ensureDaemon` 协调也迁到同一 controller，避免 CLI 和 Desktop 分别维护相似但顺序不同的逻辑。

系统服务管理不会暴露为普通 HTTP 路由。Bearer token 允许访问 daemon 数据和运行能力，不应自动扩大为修改宿主机登录启动项的权限。

## 状态一致性

统一 controller 使用“期望状态 + reconcile”模型：

- `configured` 表示配置期望；
- `serviceState` 表示操作系统真实状态；
- `enabled` 只有在配置为 true 且服务实际已安装时才为 true。

启用和关闭都必须重新读取最终状态。任何中间步骤失败时，controller 应尽可能恢复一致状态，并返回明确错误，不能只回滚 UI。

特别处理当前 Desktop 关闭路径的风险：若系统服务已经卸载但保存 `autoStart=false` 失败，配置仍为 true，CLI 下次可能重新安装。统一 controller 必须对该部分失败定义确定的收敛行为，并由 CLI、Desktop 共用测试锁定。

## 分阶段迁移

### 第一阶段：机械清理

1. Terminal 类型改从 client 导入。
2. 删除 Desktop 的 `terminal` 和 `terminal-node` 声明。
3. 保留 Vite bundling 清单。
4. 验证 Desktop node/web 类型检查、测试、build 和产物裸导入扫描。

### 第二阶段：WSL 校验归 daemon

1. 给 server settings service 增加可注入的 agent environment validator。
2. 默认 daemon composition 注入 sandbox WSL preflight。
3. daemon capability 返回执行宿主的环境支持状态。
4. Desktop 删除本机 preflight 和平台猜测。
5. 删除 Desktop 的 sandbox 声明。

### 第三阶段：统一 daemon-host

1. 增加 `@vykor/server/daemon-host` package export。
2. 把配置读写、系统服务 reconcile 和 watchdog 判断封装进去。
3. CLI 与 Desktop 迁到统一 controller。
4. Desktop 保留 Electron invocation 和 onboarding 状态。
5. 删除 Desktop 的 core 声明。

### 第四阶段：边界防回归

1. 增加静态依赖检查，Desktop 只允许 client/server workspace imports。
2. renderer/preload 禁止导入 server；server 仅允许 main 使用。
3. 验证 CLI 与 Desktop 安装的系统服务可以互相识别、升级和卸载。
4. 验证 Windows、macOS、Linux 的 install/start/status/uninstall 和失败恢复。

## 验证标准

- Desktop `package.json` 只声明 client 和 server 两个 `@vykor/*` workspace 包。
- Desktop 源码不再导入 core、sandbox、terminal 或 terminal-node。
- renderer 和 preload 不导入 server 或 `server/daemon-host`。
- CLI 与 Desktop 使用同一个 autostart controller，配置与系统服务操作顺序一致。
- WSL 设置只在 daemon 宿主预检成功后保存。
- Desktop 完整测试、CLI daemon 测试、server 测试和全仓类型检查通过。
- Desktop 主进程、preload、renderer 构建通过。
- 构建产物不存在 `@vykor/*` 裸导入。
- Windows、macOS 和 Linux 的用户级系统服务行为不回归。

## 本次明确不处理

Desktop 的 Electron Vite 配置目前直接从 `packages/services` 复制 SQLite migration。它是构建期隐藏耦合，但本次不修改。后续如需严格做到 Desktop 构建也只接触 client/server，再单独设计 server migration 资产出口。
