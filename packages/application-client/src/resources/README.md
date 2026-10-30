# 应用业务请求

[index.ts](./index.ts) 统一导出业务资源，并重用 SDK 的核心资源。

- [configuration](./configuration/README.md)：设置、提供商凭据、身份认证、全局 MCP。
- [workspace](./workspace/README.md)：项目、笔记、渠道、调度。
- [plugins](./plugins/README.md)：插件、市场、应用与历史。
- [runtime](./runtime/README.md)：开发辅助与终端。
- [session](./session/README.md)：产品会话上下文、worktree 清理和附件存储维护。

客户端构造时将同一个 SDK HTTP 连接传给各资源。资源组装请求并返回服务端结果；业务状态归 daemon 所有。生命周期、协议、权限、Jobs 和事件实现留在 SDK。新增业务资源及其测试放所属目录。
