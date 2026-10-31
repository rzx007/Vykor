# 模型用量累计

`cost-tracker.ts` 提供 `CostTracker`，累计模型返回的输入、输出、缓存创建与缓存读取 token 数。这里统计的是用量，token 可以理解为模型计算文本长度的单位；金额和定价由调用方处理。

`QueryEngine` 在实际请求结算后调用 `addUsage()`。累计值保存在 `CostTracker` 实例内，`getTotal()` 返回快照，`reset()` 清空统计。请求中断或用量不完整时，可通过 `markUsageIncomplete()` 标记，避免把不完整数据当作完整统计。

测试放在同层 `__test__/cost-tracker.test.ts`。新增实际请求用量的累计规则放在这里；请求前的上下文占用估算放在 [context-budget](../../context-budget/README.md)。

`context-input-measurement.ts` 保存最近一次模型请求的完整输入测量，供 `QueryEngine` 判断下一轮是否需要自动压缩。入口是 `capture()` 固定请求边界、`record()` 接收完整用量、`estimate()` 计算「已测输入 + 新增消息估算」。完整用量中的 `metering.knownInputTokens` 已按供应商口径包含缓存读取和缓存创建，不能再把缓存数加一次。系统提示和工具定义已包含在已测输入中，也不能重复添加。

测量只存在当前引擎实例内，不写入会话记录，也不替代消息历史。边界只保存消息数、历史与请求配置的 SHA-256 指纹和客户端身份，不复制历史正文。模型、供应商、客户端、系统提示、工具定义、输出上限、推理设置或图片处理方式不一致时退回原估算；已覆盖历史被压缩、替换或修改也会失效。手动压缩、恢复历史和清空会话主动清除测量；缺失、不完整或未知用量不会成为新测量。自动压缩阶段在历史实际改变后立即恢复原估算，接口明确报超长时仍走既有压缩恢复，不依赖测量。

`__test__/context-input-measurement.test.ts` 覆盖缓存口径、配置和历史边界；跨请求自动压缩的行为测试位于 `../__test__/context-input-measurement.integration.test.ts`。
