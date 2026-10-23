# 工具调用解析

解析模型返回的工具参数，并在生成过程中提取安全的文件路径提示。

## 主要文件

- [tool-input.ts](tool-input.ts)：校验工具参数 JSON，保留无效输入原因。
- [tool-path-summary.ts](tool-path-summary.ts)：增量识别文件工具路径，撤回歧义提示。
- [dsml-tool-call-recovery.ts](dsml-tool-call-recovery.ts)：从 DSML（某些模型输出的工具调用标记）文本恢复工具调用和进度。

## 调用与状态

这些辅助函数由上层 [providers 客户端](../README.md) 使用；它们没有从 `@vykor/api` 包根直接导出。

客户端将参数片段交给 `createToolPathSummary`，完整参数交给 `parseToolInput`；OpenAI 兼容客户端按配置使用 `createDsmlRecoveryScanner`。结果回到客户端，再作为工具调用事件返回。无效 JSON 只保留长度和位置等诊断，避免把原始参数写进错误信息。

路径扫描器和恢复扫描器各自保存一条流的未完成片段；参数解析函数本身不保存状态。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
