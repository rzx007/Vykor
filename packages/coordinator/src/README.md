# 协调器源码

[`index.ts`](index.ts) 是 `@vykor/coordinator` 的公开入口，汇总角色定义、模式与通知、团队、工作流接口。

| 目录 | 职责与公开子入口 |
| --- | --- |
| [runtime](runtime/README.md) | 模式开关和提示词；`@vykor/coordinator/coordinator-mode` |
| [definitions](definitions/README.md) | 角色解析和内置定义；`@vykor/coordinator/definitions` |
| [teams](teams/README.md) | 团队内存注册表；`@vykor/coordinator/teams` |
| [workflow](workflow/README.md) | 依赖调度、预算和快照接口；`@vykor/coordinator/workflow` |
| [__test__](__test__) | 包入口与跨分类行为测试 |

宿主先解析角色和恢复模式，再创建团队或调用 `runWorkflow()`。工作流把具体任务交给注入的 runner，结果通过返回值、事件和快照回调交回宿主。模式由进程环境变量表示，团队和调度进度在内存中，长期保存由宿主实现的 repository 负责。

根目录只保留公开导出。模式、提示词和通知放 `runtime/`，角色配置放 `definitions/`，团队放 `teams/`，工作流放 `workflow/`。测试放在实现所属分类的 `__test__/`，跨分类测试留在本层。返回[包说明](../README.md)。
