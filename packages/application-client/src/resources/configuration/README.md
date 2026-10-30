# 应用配置与认证

[system-resource.ts](./system-resource.ts) 提供全局设置、记忆、命令目录与维护；[provider-resource.ts](./provider-resource.ts) 管理提供商；[auth-resource.ts](./auth-resource.ts) 管理登录；[mcp-resource.ts](./mcp-resource.ts) 管理 MCP 配置和授权。

入口由产品客户端对应资源属性提供。方法通过 SDK 连接发起请求，服务端保存设置和凭据，返回结果后由界面决定如何展示。只读运行能力目录归公开 SDK 的 runtime；权限回复归 SDK 的 permissions。新配置功能放本目录，测试放 `__test__/`。
