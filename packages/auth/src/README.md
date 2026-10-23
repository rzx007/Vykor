# 认证源码

[index.ts](index.ts) 是 `@vykor/auth` 的公开入口，导出各分类存储与凭据选择函数，并实现 `ApiKeyFlow`、`DeviceCodeFlow` 和 `AuthManager`。

## 目录导航

- [credentials/](credentials/README.md)：API Key 文件、外部 Codex 文件和解析顺序。
- [mcp/](mcp/README.md)：MCP 授权记录持久化。
- [channels/](channels/README.md)：飞书渠道配置持久化。
- [__test__/](__test__/)：公开内存认证流程测试。

`AuthManager.registerProvider` 注册认证流程，`authenticate` 调用相应流程并把结果保存在实例的 Map，`getCredentials` 取回结果。`ApiKeyFlow` 返回构造时提供的 Key；`DeviceCodeFlow` 申请设备码、提示访问授权网址、轮询令牌，并提供显式的 refresh 方法。

`AuthManager` 的凭据只保存在内存中；文件存储由三个子分类管理，外部 Codex 文件由 Codex CLI 管理。新增通用认证流程可放本层，新增特定存储归子分类；测试放被测模块所属层的 `__test__/`。
