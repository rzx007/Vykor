# 会话工作区文件协议

[session-files.ts](./session-files.ts) 检查会话工作区文件的 HTTP 响应，并转导出 [Domain 文件契约](../../../domain-contracts/src/files/README.md) 的数据类型、五个请求解析函数和稳定 `SessionFileError`。数据定义与请求校验只在 Domain 中实现，服务端应用服务直接引用 `@vykor/domain-contracts/files`。

HTTP 入口把原始查询交给转导出的 `parseSessionFile*Input`。Domain 检查未知字段、相对路径、单行查询文本、字符串长度和数量上限，返回受约束的请求；默认数量和读取预算由服务端应用服务负责。

SDK 将响应交给 `decodeSession*` 函数，要求必要字段完整且类型正确，再返回调用方。`files` 是文件相对路径数组，搜索匹配行号从 1 开始，`modifiedAt` 使用 Unix 时间毫秒。

本目录不持有文件、会话或权限状态。会话选择工作目录、权限判定和读取操作由服务端与环境 adapter 完成。新增 HTTP 响应检查放这里，数据和请求校验放 Domain；本层响应测试放 [`__test__/`](./__test__)。
