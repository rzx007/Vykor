# 分层清理设计

## 目标

在第一批死代码清理之后，依次收口 TUI、Desktop 与 Runtime 的真实运行链路、重复实现和职责边界。每一层先建立失败测试或契约测试，再做最小改动；不把不相关的功能重写混进清理。

## TUI

- 将裸 `Record<string, unknown>` action 总线改为判别联合类型，未知 action 不得静默成功。
- 保留并接通 Workflow 面板：由 `useServerSync` 管理 workflow state 和 client 调用，App 只管理面板开关。
- 对已有 client API 的 MCP 与 Tasks 接入真实数据；会话切换和断线时清空旧数据。
- Todo、Swarm、Bridge 若没有当前 daemon/client 数据源，则从生产 controller 与不可达展示通道移除；历史 transcript 的 workflow/swarm 摘要解析可以保留，因为它有真实输入。
- `useServerSync` 只做有行为收益的拆分，不为降低行数而大搬家。

## Desktop

- 在 shared 中建立唯一、type-only 的 `DesktopAPI` 契约；preload 对象用 `satisfies` 校验，renderer 全局声明只引用共享类型。
- 将 `window:maximized-changed` 迁入集中事件常量，将 IPC registration channel 收窄为 `IpcChannel`。
- 为 MainLayout/SettingsLayout 重复窗口 chrome 状态抽取 renderer hook，保留各自导航和面板状态。
- 在消息代码块行为测试保护下，删除 `MultiFileCodeBlock`、`LanguageTabsCodeBlock`、`InstallCommand` 及其独占支持代码。
- 不改用户在途的 utility/browser/terminal/main.css 文件。

## Runtime

- 把 memory extraction 的无状态规则移动到 `@vykor/memory`，runtime 与 services 仅保留消息/模型/存储适配；两条路径共享 fixture。
- 让 extension discovery 纯读取；plugin agent activation 显式发生在创建 runtime 的 composition root，并避免 command/context 读取覆盖进程全局状态。若 coordinator 目前只能使用全局 registry，先改成按 runtime/cwd 可注入的定义集合，不用锁掩盖所有权问题。
- `agent-runtime` 的 child environment 是 worktree canonical。对 `@vykor/swarm` 采用可逆兼容策略：仓库内无消费者时移除重复实现或改为薄兼容转发；不能确认外部兼容时不删除整个发布包。
- 将 `agent.ts` 拆成 facade、单轮 run 状态机、composition 和内部错误工具，保持现有 cleanup 顺序和公开导出不变。

## 验证与约束

- 不提交、不推送、不发布。
- 不覆盖工作树中用户已有改动。
- 每一域运行聚焦测试、类型检查与可用 lint；既有外部阻断单独记录。
- 所有删除都必须有引用扫描；所有行为修复必须先有能复现问题的失败测试。
