# 会话工作区只读文件资源

[files-resource.ts](./files-resource.ts) 提供 `FilesResource`，由 `client.files` 和私有应用客户端共用。入口包括 `list`、`stat`、`readText`、`find` 和 `search`，分别读取目录、文件信息、UTF-8 文本、glob 文件路径和单行字面文本匹配。

每次调用传会话 ID 和工作区相对路径；资源将请求映射为 `/sessions/:id/files` 下的 GET 地址，通过 `HttpTransport.path` 编码查询参数。取消信号单独交给传输层，不进入查询。传输层先完成协议握手和鉴权，再发请求；响应经 Protocol 检查后返回，非成功 HTTP 响应仍抛出 `VykorApiError`。

客户端不保存文件内容或权限状态，也不选择宿主目录。daemon 根据会话确定实际工作区，执行授权及读取。新增只读文件请求放本目录，相关测试放 [`__test__/`](./__test__)；请求选项在 [file-types.ts](../../types/file-types.ts)。
