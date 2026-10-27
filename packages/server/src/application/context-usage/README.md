# 上下文用量统计

汇总会话当前使用的上下文与模型容量，并把活跃运行接到缓存。

## 入口与流程

组装函数读取会话和模型限制，缓存保存最近统计值。Application 建好 Agent 池后绑定实时组装函数；查询出口通过绑定器取得当前函数，结合活跃 Agent 刷新并返回统计结果。

## 状态归属

最近统计保存在进程内缓存；绑定器只保存当前绑定。每次 `bindContextUsageLiveAssembler` 都建立独立归属，并返回只释放这次绑定的函数，即使再次传入相同回调也不共用归属。Application 保存该释放函数，在正常关闭开始时或绑定后的同步构造失败时调用；旧绑定释放不会清除较新绑定，重复释放没有副作用，当前绑定释放后查询会返回 `undefined`。这仍是进程内的单个当前绑定，不代表支持多个完整 Application 并行运行。模型限制和会话事实来自传入的服务。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [assemble-session-context-usage.ts](./assemble-session-context-usage.ts) | `ModelVisibleTool`、`SessionContextUsageAgent`、`AssembleSessionContextUsageInput`、`ModelContextLimits` 等 |
| [context-usage-cache.ts](./context-usage-cache.ts) | `ContextUsageCache`、`createContextUsageCache`、`sharedContextUsageCache`、`getSharedContextUsageCache` |
| [context-usage-live-binder.ts](./context-usage-live-binder.ts) | `ContextUsageLiveAssembler`、`bindContextUsageLiveAssembler`、`getBoundContextUsageLiveAssembler` |

## 测试与维护

统计组装、刷新和模型容量解析放在这里；模型目录与供应商配置放在 default-services/models。`__test__/context-usage-live-binder.test.ts` 覆盖绑定归属与重复释放；Application 的同步构造失败和正常关闭回归放在上层 `__test__/daemon-application-context-usage.test.ts`。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
