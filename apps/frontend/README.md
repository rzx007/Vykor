# Vykor TUI

使用 OpenTUI 和 React 的终端界面，运行在 Bun 中。用户通常通过 `vk` 或 `vk --tui` 启动，由 CLI 确认 daemon 连接并把连接信息传给本包。

## 运行过程与状态

`src/index.tsx` 读取 `VYKOR_FRONTEND_CONFIG` 并启动终端渲染器，`src/App.tsx` 创建界面；`src/hooks/useServerSync.ts` 通过 `@vykor/application-client` 提交操作、读取快照和消费 SSE 变化。输入、消息、权限、Run 和后台任务保存在 daemon，前端只保存当前选择、弹窗和显示状态。

私有应用客户端复用公开 SDK `@rzx/client` 的会话与事件同步，另提供插件、命令和提供商等产品接口；Bun 构建把它们一起打进终端入口。

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
| `src/services/`、`src/utils/`、`src/types/` | 界面服务、辅助函数和界面类型 |

新增功能沿用对应页面或交互目录；测试按[仓库约定](../../AGENTS.md)放在被测模块所属的 `__test__/`，不为历史结构增加转发文件。

## 开发与检查

在仓库根运行 `pnpm --filter @vykor/frontend build` 或 `pnpm --filter @vykor/frontend check-types`。单包测试使用 `pnpm --filter @vykor/frontend test`，需要 Bun。

体验开发通过 `bun apps/cli/src/index.ts --tui` 启动完整连接流程；仅运行前端源码需要自行提供有效 daemon 连接配置。CLI 参数见 [CLI README](../cli/README.md)。
