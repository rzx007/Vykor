# 协作笔记

作者执行 `npm ci && npm run build`，分发包含 `server.mjs` 和单文件 `ui/panel.html`，安装后无需 npm。MCP 服务使用 Node，Native 工具插件不需要额外服务。

页面使用官方 ext-apps 1.1.2。用户手工保存；写入携带文档版本 `expectedRevision` 与 `operationId`。冲突时草稿保留，用户对照最新正文手工合并。相同操作 ID 的相同请求返回原回执，异参数拒绝。应用不自动保存，不在断连后重放操作。选区通过官方 `updateModelContext` 进入可见会话草稿，再由用户发送。

`read_note` 和 `apply_note_operations` 对模型和页面可见；`list_notes`、`save_note_draft` 仅页面可见。可见性不替代宿主权限。宿主在鉴权资源读取后订阅 `notes://welcome`，将更新合并成标准 `ResourceListChanged`；页面收到后重读。没有自定义页面消息协议。服务端业务文档版本与宿主应用控制版本独立。

单个 stdio 服务串行处理一份笔记，原子替换文件同时保存正文、版本和操作回执。清单显式绑定安装根和已有插件 dataDir；数据在 `dataDir/sessions/<原会话ID的SHA-256>/welcome.json`。同一会话的页面与模型共享原后台；不同会话目录隔离。服务拒绝缺少宿主绑定的普通启动，不写安装快照。测试可用 `VYKOR_NOTES_FILE` 指定临时文件。回执达到 10000 条时拒绝新写入，不清除去重事实。测试均指定临时文件。
