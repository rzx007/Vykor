# Vykor TUI

使用 OpenTUI 和 React 的终端界面，运行在 Bun 中。用户通常通过 `vk` 或 `vk --tui` 启动，由 CLI 确认 daemon 连接并把连接信息传给本包。

## 运行过程与状态

`src/index.tsx` 读取 `VYKOR_FRONTEND_CONFIG` 并启动终端渲染器，`src/App.tsx` 创建界面。`src/hooks/useServerSync.ts` 通过 `@rzx/client` 提交会话操作、回复权限、读取快照和消费 SSE 变化。输入、消息、权限、Run 和后台任务保存在 daemon，前端保存当前选择、弹窗和显示状态。

设置、知识、工作区和插件通过对应的 `@vykor/daemon-admin` 子入口访问。[TUI 斜杠命令](src/hooks/commands/README.md)在本包分发，使用 daemon 报告的工作目录。AskUser 待答请求和工具审批分别显示，回复作用于当前会话中对应的待处理请求，状态继续以同步结果为准。Bun 构建会将公开 SDK 和管理资源打入终端入口。

完整链路见 [TUI 流程](../../docs/tui-flow.md)与[客户端同步](../../docs/client-sync-flow.md)。本包不能直接读取会话数据库，也不创建第二套 Agent 或权限执行入口。

## 目录导航

| 目录 | 用途 |
| --- | --- |
| `src/routes/` | 会话及其他终端页面 |
| `src/components/`、`src/ui/` | 业务组件与通用终端控件 |
| `src/hooks/` | 客户端同步、会话操作与输入交互 |
| `src/jobs/` | 后台任务列表及详情 |
| `src/keymap/` | 键盘映射 |
| `src/theme/` | 终端主题 |
| [src/services/](src/services/README.md)、`src/utils/`、`src/types/` | 界面服务、辅助函数和界面类型 |

新增功能沿用对应页面或交互目录；测试按[仓库约定](../../AGENTS.md)放在被测模块所属的 `__test__/`，不为历史结构增加转发文件。

## 开发与检查

在仓库根运行 `pnpm --filter @vykor/frontend build` 或 `pnpm --filter @vykor/frontend check-types`。单包测试使用 `pnpm --filter @vykor/frontend test`，需要 Bun。

测试命令先加载 [隔离测试主机](src/__test__/setup-isolated-host.ts)，再导入界面。整个 Bun 进程使用独占临时 home、用户根和桌面环境目录，避免跨文件共享的频率缓存读写真实用户数据；退出时清理临时目录。频率存储用例在改变测试根前先关闭旧缓存。

体验开发通过 `bun apps/cli/src/index.ts --tui` 启动完整连接流程；仅运行前端源码需要自行提供有效 daemon 连接配置。CLI 参数见 [CLI README](../cli/README.md)。
