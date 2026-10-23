# 上下文用量统计

汇总会话当前使用的上下文与模型容量，并把活跃运行接到缓存。

## 入口与流程

组装函数读取会话和模型限制，缓存保存最近统计值，实时绑定器监听执行变化后刷新，结果由应用查询出口返回。

## 状态归属

最近统计与订阅绑定保存在进程内；模型限制和会话事实来自传入的服务。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [assemble-session-context-usage.ts](./assemble-session-context-usage.ts) | `ModelVisibleTool`、`SessionContextUsageAgent`、`AssembleSessionContextUsageInput`、`ModelContextLimits` 等 |
| [context-usage-cache.ts](./context-usage-cache.ts) | `ContextUsageCache`、`createContextUsageCache`、`sharedContextUsageCache`、`getSharedContextUsageCache` |
| [context-usage-live-binder.ts](./context-usage-live-binder.ts) | `ContextUsageLiveAssembler`、`bindContextUsageLiveAssembler`、`getBoundContextUsageLiveAssembler` |

## 测试与维护

统计组装、刷新和模型容量解析放在这里；模型目录与供应商配置放在 default-services/models。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
