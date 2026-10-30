# 产品客户端入口

[index.ts](./index.ts) 导出产品使用的同名 `VykorClient`、业务类型与公开 SDK 能力；[application-client.ts](./application-client.ts) 只负责组装资源。

创建客户端后，业务调用进入 [resources](./resources/README.md)，共用 SDK 的 HTTP/SSE 连接。会话和附件资源继承 SDK 类，只补产品管理方法。数据保存在 daemon；调用方持有的同步状态由 SDK 管理。

[commands](./commands/README.md) 负责界面命令，[types](./types/README.md) 补业务定义。新增代码放相应分类，跨分类请求回归放 `__test__/`。
