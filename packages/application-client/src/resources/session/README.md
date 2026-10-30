# 产品会话与附件维护

[session-resource.ts](./session-resource.ts) 继承 SDK SessionResource，补充插件应用输入类型、应用快照字段和归档会话 worktree 绑定清理；[attachment-resource.ts](./attachment-resource.ts) 继承 SDK AttachmentResource，补存储扫描、修复和垃圾清理。

入口为客户端 sessions 和 attachments。普通生命周期及附件读写直接由父类执行，管理方法共用 SDK HTTP 连接调用 daemon。绑定、附件、清理记录均由 daemon 保存；本目录不持有会话状态或复制事件同步逻辑。产品管理新增代码放这里，测试放 `__test__/`。
