# Daemon 管理调用

CLI、TUI 和 Desktop 主进程用这里的子入口访问 daemon 管理接口。调用方用已有地址、凭据和 `HttpTransport` 构造所需资源。资源将请求送到已有 HTTP 路由，然后返回回执或事件流。模型凭据、配置、项目知识、渠道状态、MCP 授权和插件记录保存在 daemon 管理的数据根中。

- [configuration](./src/configuration/README.md) 读取和更新设置、模型提供商、凭据、Profile 与输出样式。
- [knowledge](./src/knowledge/README.md) 管理项目记忆、事实和上下文，启动 Dream。
- [workspace](./src/workspace/README.md) 查命令目录和 Hook，在 daemon 工作目录初始化项目及操作 Git。
- [channels](./src/channels/README.md) 管理渠道运行、飞书接入和允许名单。
- [mcp](./src/mcp/README.md) 查询和同步活动 MCP，管理 OAuth 操作。
- [plugins](./src/plugins/README.md) 查询、安装和管理共享插件。

包为工作区私有依赖，使用上述六个子入口。会话、运行、普通能力查询和事件同步使用公开 `@rzx/client`。

```powershell
pnpm --filter @vykor/daemon-admin check-types
pnpm --filter @vykor/daemon-admin test
```
