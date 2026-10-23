# 消息流整理

把正文中的思考标记和不同服务商的 token 用量整理成统一结果。

## 主要文件

- [think-blocks.ts](think-blocks.ts)：拆分可见正文、思考内容和待续片段。
- [token-metering.ts](token-metering.ts)：校验输入、输出与缓存用量，标记统计是否完整。

## 调用与状态

由 [providers 客户端](../README.md) 调用 `extractThinkBlocks` 和 `normalizeTokenMetering`；两个函数没有从包根直接导出。

文本流逐段进入思考块提取函数，返回正文、思考和 leftover；客户端把 leftover 带到下一次调用，结束时使用 `final`。用量函数根据原始计数和缓存口径返回已知数量及 complete、partial 或 unknown。

两个模块都不保存共享状态；未完成文本由调用它们的单次客户端请求持有，原始用量随结果保留。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
