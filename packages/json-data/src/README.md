# 通用 JSON 处理

[json.ts](json.ts) 是 `@vykor/json-data/json` 的公开入口，提供 `JsonValue`、对象判断、大小校验、稳定序列化和受限制复制。

`validateJsonRecord` 检查普通对象，再用按键排序的 JSON 文本计算 UTF-8 字节数，返回有效数据或 `invalid_json`、`payload_too_large` 原因。`isJsonRecord` 只返回判断结果，`stringifyCanonicalJson` 返回稳定文本，便于比较或计算摘要。

`copyBoundedJson` 接收显式 `maxBytes`、`maxDepth`，在复制时检查数据类型、循环、访问器和大小限制，返回不保留输入引用的新值。它失败时抛出 `JsonCopyError`。与复制函数不同，稳定序列化函数会读取可枚举属性的值，不应用来承诺拒绝访问器。

遍历路径、字节预算和副本都属于本次调用，不保存跨调用状态。新增通用 JSON 辅助函数放 `json.ts`，测试放 [__test__](__test__/)，覆盖固定字节结果、大小和深度边界及非法数据。
