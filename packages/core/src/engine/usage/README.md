# 模型用量累计

`cost-tracker.ts` 提供 `CostTracker`，累计模型返回的输入、输出、缓存创建与缓存读取 token 数。这里统计的是用量，token 可以理解为模型计算文本长度的单位；金额和定价由调用方处理。

`QueryEngine` 在实际请求结算后调用 `addUsage()`。累计值保存在 `CostTracker` 实例内，`getTotal()` 返回快照，`reset()` 清空统计。请求中断或用量不完整时，可通过 `markUsageIncomplete()` 标记，避免把不完整数据当作完整统计。

测试放在同层 `__test__/cost-tracker.test.ts`。新增实际请求用量的累计规则放在这里；请求前的上下文占用估算放在 [context-budget](../../context-budget/README.md)。
