# TUI 斜杠命令

[`sessionSlashCommands.ts`](./sessionSlashCommands.ts) 接收 TUI 当前会话、运行状态和输出回调，调用 [`session-commands.ts`](./session-commands.ts) 分发命令。命令目录由 daemon 返回。本地命令表补充仅由终端界面处理的动作。

- [`session-commands.ts`](./session-commands.ts) 解析和分发命令，并处理会话动作、项目初始化、Git 与插件操作。
- [`diagnostic-commands.ts`](./diagnostic-commands.ts)、[`job-commands.ts`](./job-commands.ts)、[`knowledge-commands.ts`](./knowledge-commands.ts) 和 [`settings-commands.ts`](./settings-commands.ts) 负责各自的命令和输出。
- [`plugin-presentation.ts`](./plugin-presentation.ts) 把插件重载的结果和可执行的恢复提示整理成终端文本。

分发时优先采用活动会话从 daemon 得到的工作目录，没有活动会话时使用连接配置中的目录。公开会话、模型等运行信息和 Jobs 由 `@rzx/client` 读取或操作。设置、知识、项目和插件由各自的后台管理资源访问。会话、配置、工作区修改与执行状态由 daemon 管理，TUI 保存选择状态和展示缓存。

新增斜杠命令按职责放在这里。测试在 [`__test__/`](./__test__/)，覆盖命令选择、资源调用和返回文本。连接后的请求与错误展示由 [`useServerSync.test.tsx`](../useServerSync.test.tsx) 覆盖。
