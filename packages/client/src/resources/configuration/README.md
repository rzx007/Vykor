# 运行权限资源

[permission-resource.ts](./permission-resource.ts) 导出 `PermissionResource`，通过 `client.permissions` 查询待处理权限请求，并用 `reply` 明确批准或拒绝。回复结果来自 daemon，执行是否继续由服务端权限流程决定。

权限请求和决定由 daemon 保存，客户端快照和事件只维护其本地视图。等待 Run 的函数不会自动回复请求；界面或脚本必须提供自己的权限处理方式。

登录、模型提供商、全局设置和 MCP 管理已迁入 [私有应用客户端](../../../../application-client/README.md)。这里只放生命周期中的权限请求操作；测试放 [`__test__/`](./__test__)。
