# 独立 daemon 实现计划

> 面向实现代理。按任务验证，先跑失败用例再实现。完整约束见 [设计文档](../specs/2026-11-06-standalone-daemon-design.md)。

**目标**让 Desktop 和 CLI 连接同一个独立本机后台，并保留桌面浏览器、环境终端、常驻与数据切换。

**结构**先接通浏览器，再实现共享后台的所有权和目录选择。最后把 Desktop 的内置服务替换成无窗口入口。服务端负责会话、任务、审批和数据，桌面负责 Electron 标签页。HTTP 和 SSE 沿用现有传输。

**技术**Electron、Node、Hono、Vitest 和已有的登记文件启动锁。

## 任务 1 浏览器桥接

- [x] 在 `packages/server/src/application/browser-tools/` 下实现代理和窄消息类型。将 `BrowserHost` 的执行信号传给代理。用 `GET /browser-host/stream` 建立单条 SSE，发送 `hello`、`command` 和 `cancel`。用 `POST /browser-host/:connectionId/:requestId/approval` 返回审批决定，用相邻的 `result` 路由完成一次操作。
- [x] 将路由挂到 HTTP 服务。启用条件是已登记的本机后台、实际 loopback 监听和 token。拒绝 Origin 和 Fetch Metadata。流关闭时取消操作，关服务时也关闭流。使用 `features.browserBridge` 表示路由支持。
- [x] 在 `apps/desktop/src/main/features/browser/` 中加入连接逻辑，复用应用客户端导出的 HTTP/SSE 传输。审批沿用原有权限回调。每次操作通过窗口会话令牌限定范围，页面更换时阻止使用旧审批。关闭连接时停止开发诊断。截图结果限制到现有 8 MiB 上限，编码后的请求使用相应的流式硬限。
- [x] 回归用例先覆盖收到操作后断流时的未知结果，再覆盖审批和结果的请求关联、旧连接拒绝、无 token 或带 Origin 被拒绝、窗口会话变化，以及正常操作返回。运行服务端浏览器和 Desktop browser 目录的 Vitest 用例。更新相关 README 和 [浏览器能力](../../browser-capabilities.md)。

## 任务 2 共享登记和数据位置

- [x] 在 `packages/server/src/daemon-host/` 中实现共享本机后台运行入口。注册者先取得固定登记路径的独占权，再打开数据库。原子写登记。退出时验证完整实例身份后再删除登记。进程持有独占权到全部关闭结束。CLI 显式远程监听或自定义数据库使用现有入口。
- [x] 在同目录管理基础登记路径和已提交数据选择。处理已有 Electron 数据位置文件，保留自定义数据库路径。有效 `VYKOR_DATA_DIR` 只在后台进程内变更。测试默认路径、原子写、选择文件兼容和数据库路径验证。
- [x] 在本机按需后台接入数据切换维护路由。沿用安全重启的工作准入检查。带切换 ID 记录接收状态并回包，然后关闭旧应用和监听，在原 PID 下打开目标。目标就绪后提交选项和登记，再启用自主工作。失败时恢复旧库。测试活动任务拒绝、目标启动失败恢复、提交后重新连接和中断恢复。
- [x] CLI 已登记入口和桌面无窗口入口都调用共享后台运行入口。用临时目录启动两个进程，验证只发布一个兼容实例，并验证退出后登记归属。更新服务端、CLI 和系统常驻文档。

## 任务 3 产品切换

- [x] 在 `DaemonConnectionService` 用 SDK 服务发现和按需启动取代内置服务。读取服务能力并验证所需桌面功能，复用兼容 CLI daemon。对仍活着但不可达的登记保留并提示重试。桌面使用现有无窗口入口作为启动命令。系统常驻控制沿用现有调用边界。
- [x] Desktop 连接后启动私有浏览器流，连接失效时取消。把数据目录切换请求发给后台，按切换 ID 等待登记更新，并在成功或失败恢复后重建 client 和订阅。确保显式重启继续安全收尾。保留数据目录切换要求先停用系统常驻的限制。
- [x] CLI 复用兼容的桌面进程，已有健康后台无需按客户端版本重启。启动失败、明确停止及升级继续提供用户可读结果。比较环境能力，避免把登记里的启动归属当成能力。
- [x] 验证 CLI 先启动、桌面先启动、同时启动、常驻先启动和活进程不可达。检查两个 client 读取同一会话与事件。更新 [Desktop](../../../apps/desktop/README.md)、[CLI](../../../apps/cli/README.md)、[系统常驻](../../daemon-system-service.md)、[浏览器能力](../../browser-capabilities.md) 和涉及的数据恢复说明。

## 整体检查

- [x] 运行 `pnpm --filter @rzx/client build`、`pnpm --filter @vykor/agent-runtime build` 和改动包的类型与目标测试。
- [x] 运行 `pnpm check:retired-ui`、`pnpm check-docs` 和桌面 workspace 边界检查。
- [x] 子代理审查完整变更，核对测试是否覆盖两个进程、权限回调、停止、并发和失败恢复。


## 验收记录

- 双进程用例使用不同的 PID 竞争同一份登记。两端连接同一个后台 PID，通过 HTTP 读到同一条会话，并通过 SSE 收到同一条创建事件。
- 真实 HTTP 和 SQLite 用例验证切换返回 202，随后用新 token 连回同一个后台 PID。另有用例验证活动任务阻止切换、打开失败恢复旧库，以及中断后使用最后提交的位置。
- 子代理复审后补了导航取消、启动锁竞争、旧配置迁移和 Windows 停用常驻后的数据切换。
- 类型检查、客户端 API、桌面与仓库依赖边界、旧引用清单及文档检查均通过。进程测试使用临时目录。Windows/macOS/Linux 安装包和真实系统启动项留给发行验收。
