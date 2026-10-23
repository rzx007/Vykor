# Agent 共用契约源码

[index.ts](index.ts) 是 `@vykor/agent-contracts` 的公开入口，汇总下列分类。`tool-data`、`permissions` 子入口分别直接指向 [tools/tool-data.ts](tools/tool-data.ts) 和 [policy/permissions.ts](policy/permissions.ts)。

| 分类 | 主要内容 |
| --- | --- |
| [execution](execution/README.md) | 运行控制、子 Agent、执行事件 |
| [conversation](conversation/README.md) | 消息、内容块、只读集合 |
| [model](model/README.md) | 模型流、重试、失败、用量 |
| [tools](tools/README.md) | 工具调用上下文、结果和名称整理 |
| [policy](policy/README.md) | 权限与 Hook 回调 |

消费方导入这些定义，构造请求或结果，并由自己的运行实现保存状态。这里的类型不创建会话、不调度模型，也不保存业务记录。少量辅助函数直接返回结果，错误对象只携带当前错误的信息。

新增源码放对应分类，公开成员在 `index.ts` 汇总。单分类测试放分类内的 `__test__/`，多个分类一起验证的测试放 [__test__](__test__/)。
