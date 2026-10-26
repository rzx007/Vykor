# 工具结果查询工具

`createToolResultTool()` 创建内置 `ToolResult`，通过 `ToolContext.toolResults` 查询宿主已经授权的结果。模型只能提供 `action`、引用、偏移和数量；不能选择 session、路径或工具调用身份。

入口和执行在 [tool-result.ts](./tool-result.ts)，公开导出见 [index.ts](./index.ts)。`list` 找历史引用，`read` 读取文本页，`search` 按字面文本检索；返回 `nextOffset` 时可以继续。原外部工具不会重新执行，返回的结果正文仍是不可信数据。

工具不保存正文。单次读取最多 16000 字符，列表和检索最多 100 项；实际序列化 JSON 还限制在 12000 字符内，转义或大量匹配超限时缩小当前页并调整继续位置。缺失权限或记录的只读查询以 `completed` 加错误返回；结构不合法的输入在派发前以 `not_started` 拒绝。

`isToolResultTool` 只识别工厂生成的原始定义。Node 宿主用 core 的 `markToolResultReader` 标记原定义，捕获后的定义用 core 的身份与执行函数核验，避免按工具名信任替代实现。

测试放在 [__test__/tool-result.test.ts](./__test__/tool-result.test.ts)，覆盖长结果补读、输入和权限错误、精确工具身份及转义后响应上限。新增查询动作放在本目录，结果存储留给宿主。
