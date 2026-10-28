# Agent 交互组件

供桌面工作流复用的任务列表与折叠组件。

- [agent-disclosure.tsx](agent-disclosure.tsx)：通用内容展开与收起，支持减少动态效果。
- [task-rows.tsx](task-rows.tsx)：复用已安装的 TaskRows 组件与类型。
- [todo-list.tsx](todo-list.tsx)：展示任务状态、进度和详情，支持受控或组件内的展开状态。

调用方提供任务数据和状态更新；组件只负责展示，展开状态由调用方或组件实例持有。工作流数据与执行状态放在对应功能目录。

新增可复用的 Agent 任务交互组件放在这里，测试放在同层 `__test__/`；消息正文的 Markdown 渲染继续放在会话消息目录。
