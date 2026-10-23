# @vykor/agent-contracts

执行双方共用的数据和接口，包括消息、模型用量与失败、子 Agent 预算、工具执行上下文、事件、Hook 回调和权限判定。包内也放少量与宿主无关的校验、名称整理和只读集合函数。

不读取配置、不调用 Node，也不引用 core 或宿主实现。这里定义执行双方要交换什么；运行、重试、权限记录、消息保存和子 Agent 生命周期由消费方管理。

## 目录导航

| 目录 | 用途 |
| --- | --- |
| [src](src/README.md) | 公开导出和跨分类测试 |
| [execution](src/execution/README.md) | 单次运行、子 Agent 和事件接口 |
| [conversation](src/conversation/README.md) | 消息内容和只读集合 |
| [model](src/model/README.md) | 模型请求、重试身份、失败和用量 |
| [tools](src/tools/README.md) | 工具定义、结果、名称和 Shell 输出接口 |
| [policy](src/policy/README.md) | 权限请求、判定和 Hook 回调接口 |

公开入口由 [package.json](package.json) 声明：`@vykor/agent-contracts` 对应 [src/index.ts](src/index.ts)，另有 `@vykor/agent-contracts/tool-data` 和 `@vykor/agent-contracts/permissions` 两个子入口。

新增内容放入对应分类，并按需要从 `src/index.ts` 导出。分类内测试放该目录的 `__test__/`，跨分类测试放 [src/__test__](src/__test__/)。可运行 `pnpm --filter @vykor/agent-contracts test` 检查本包。
