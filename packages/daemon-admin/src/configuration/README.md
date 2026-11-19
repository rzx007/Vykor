# 设置与凭据

从 `@vykor/daemon-admin/configuration` 使用 `SystemResource`、`ProviderResource` 或 `AuthResource`。对应文件分别访问设置与 Profile、提供商配置、认证状态及登录路由。daemon 保存设置和凭据，也负责检测编辑冲突和更新运行时。显式刷新模型目录用 `ProviderResource.refreshModels`，日常模型读取用公开 SDK 的 `runtime.listModels`。

新增设置、提供商或凭据请求放在相应资源，相关请求和回执类型放在 `types.ts`。
