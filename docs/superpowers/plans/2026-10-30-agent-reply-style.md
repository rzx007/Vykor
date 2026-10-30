# Agent 回复风格实现计划

**目标：** 将三档回复风格贯穿桌面、配置、会话与模型请求。

**实现：** 共享纯值类型归 agent-contracts，配置归 host-config，提示词内容归 prompts，运行时按每次请求的快照构建；桌面与服务端在明确文件边界内并行接入。

**技术栈：** TypeScript、React、现有 Select、Vitest、pnpm。

## 任务 1：共享配置与提示词

- [x] 在 host-config 的 `__test__` 增加默认值、持久保存、项目覆盖与非法值测试，先运行确认缺少实现。
- [x] 新增 `agent-contracts/src/conversation/reply-style.ts`，公开 `ReplyStyle`、`DEFAULT_REPLY_STYLE`、`isReplyStyle`；接入 Settings 与请求配置。
- [x] 新增 prompts 的组装测试，覆盖三档与两档进度通知的组合、单套风格、个人偏好保留和上下文统计。
- [x] 新增 `prompts/src/reply-styles.ts`；接入组装与 ledger 选项；协调固定语气、排版和快速模式。
- [x] 运行 `pnpm --filter @vykor/host-config test` 与 `pnpm --filter @vykor/prompts test`。

## 任务 2：服务端与会话

- [x] 先增加配置写入、导入导出、会话覆盖与恢复继承的失败测试。
- [x] 修改 server 配置校验、会话 runtime 校验/合并、daemon 快照和上下文用量入口；domain-contracts 增加 `replyStyle` 会话字段。
- [x] 会话 `inherit` 保存为显式跟随值，解析后的请求使用当前全局风格；子会话持久记录接收 spawn 的风格值。
- [x] 运行 server 与 domain-contracts 相关测试，更新职责 README。

## 任务 3：桌面

- [x] 先增加设置快照与保存路径测试。
- [x] 贯通 shared 类型、IPC、preload 和 settings service 的 `updateReplyStyle`；复用现有组件展示三档选项。
- [x] 更新“进度通知”文案、设置搜索和测试 fixture，保持失败回退与键盘操作。
- [x] 运行桌面必要测试和类型检查；按用户约定不启动预览或截图。

## 任务 4：运行时与验收

- [x] 先通过模拟模型收到的请求，验证风格更新、会话优先、完整 systemPrompt 覆盖与子 Agent 继承。
- [x] 接入程序接口配置、内存请求配置校验、default-runtime 提示词选项与子 Agent 推导。
- [x] 更新受影响目录 README，加入真实模型对照场景与人工评分说明。
- [x] 运行受影响包测试和类型检查、`pnpm check:retired-ui`、`pnpm check-docs`，请求独立代码审查并修复确认的问题。
