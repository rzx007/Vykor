# 会话工作区只读文件 API

用户已批准第一期：目录浏览、文件信息、文本读取、文件名与内容搜索；按会话绑定实际工作目录，复用执行环境与权限规则。

## 边界与流程

公开 `client.files` 是通用工作区能力。只传 sessionId 与相对路径，不接受 cwd、环境选择或任意宿主目录。HTTP 入口位于 `/sessions/:sessionId/files`；默认连接已有 daemon，不启动 Agent、不调用模型、不写文件或会话事件。

请求先校验会话与应用就绪状态，同步取得 operationGate 许可，再按 sessionSettingsRoot 读取配置并取得该会话实际环境。Desktop 使用既有 local/WSL 环境工厂；CLI advanced 与当前 Agent 一样使用本机环境。所有路径按执行环境规范化并检查真实路径仍位于 workspace，逐项执行已有 PermissionChecker 与 sandbox denyRead 规则；ask 按拒绝处理，不自动批准、不创建审批。配置中的明确拒绝在 full_access 下仍有效。读完、失败、取消均先释放环境，再释放操作许可。

## 接口与数据

- `files.list(sessionId, { path?, limit?, signal? })` -> SessionDirectoryResult；GET files。
- `files.stat(sessionId, path, { signal? })` -> SessionFileInfo；GET files/stat。
- `files.readText(sessionId, path, { maxBytes?, signal? })` -> SessionTextFileResult；GET files/text。
- `files.find(sessionId, { pattern, path?, limit?, signal? })` -> SessionFindFilesResult；GET files/find。pattern 为文件路径 glob。
- `files.search(sessionId, { query, path?, include?, caseSensitive?, limit?, signal? })` -> SessionSearchFilesResult；GET files/search。query 为单行字面文本，不执行用户正则。

SessionFileInfo: path/name/kind(file|directory|symlink|other)，sizeBytes/modifiedAt 可选；所有 path 都是会话根目录相对路径，根为 `.`。目录结果含 path/entries/truncated；读取结果含 path/content/encoding(utf-8)/truncated；查找结果含 path/files/truncated；内容搜索结果含 path/matches[{path,line,text}]/truncated，line 从1开始。

domain-contracts/files 保存唯一的纯数据类型、请求解析与稳定 SessionFileError，不依赖 Node 或服务端；Protocol 重导出这些契约并检查 HTTP 响应。服务端应用服务拥有授权与操作流程；环境 adapter 执行文件读取；SDK 只发送请求和解析响应。内部应用 facade 复用同一个 FilesResource。

## 上限与行为

list 默认200项、最大1000；find 默认100项、最大1000；search 默认100条、最大200；文本默认256KiB、最大1MiB。搜索每文件读取最多256KiB，总读取最多8MiB，最多检查4000个目录项，最长10秒；达到预算返回 truncated=true。直接操作超时或取消返回明确错误。文件名 glob/query/include 限256字符，相对路径限4096字符，拒绝绝对路径、..、NUL和反斜杠；Windows拒绝冒号设备流。二进制或非法 UTF-8 直接读取返回 file_not_text，搜索跳过。文件遍历跳过 .git/node_modules/dist/build/.next/.turbo 等现有生成目录；不递归进入符号链接目录，文件链接必须验证目标仍在工作区且可读。

请求错误用 file_invalid_request(400)、file_forbidden(403)、file_not_found(404)、file_not_text(415)、file_not_ready(503)、file_not_supported(501)、file_timeout/file_cancelled(408)、file_operation_failed(500)。消息不暴露宿主绝对路径。

## 验收

覆盖两个会话/子会话/worktree 的不同根、无 Agent 初始化、未鉴权/错误协议、越界与链接、根允许但子项禁止、显式 deny/ask、WSL 路径、真实 size/mtime、有界读取与 UTF-8 边界、取消/释放、搜索过滤/结果上限、非法输入。公开契约与独立 Node/browser 安装包同步更新；运行相关类型/测试、check:retired-ui 和 check-docs。
