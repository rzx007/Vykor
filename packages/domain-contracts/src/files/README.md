# 会话工作区文件契约

本目录保存会话工作区只读文件的数据和请求校验，供服务端应用服务与 HTTP 协议层共用，不依赖 Node、文件系统或 HTTP。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/files` 公开入口 |
| [records.ts](records.ts) | 目录、文件信息、文本、查找与内容搜索的数据，以及稳定 `SessionFileError` 和错误码 |
| [validation.ts](validation.ts) | 五种请求解析和共用的纯数据/相对路径检查 |

调用方将未知输入交给 `parseSessionFile*Input`，检查未知字段、相对路径、字符串长度和数量上限。解析器接受十进制整数字符串及 `true`/`false`，保留未传参数；查询文本为单行字面文本。默认数量与读取预算由服务端应用服务负责。

路径使用 `/`，工作区根为 `.`，拒绝绝对路径、`..`、反斜杠和 NUL；POSIX 冒号文件名保留，Windows 冒号限制由实际执行环境检查。`files` 是相对文件路径数组，搜索匹配行号从 1 开始，`modifiedAt` 使用 Unix 时间毫秒。

本目录不保存文件或会话状态，也不执行授权或读取。服务端负责按会话选择工作区并执行操作；Protocol 负责 HTTP 响应检查。新增数据和请求校验放本目录，相关测试放 [`__test__/`](./__test__)。
