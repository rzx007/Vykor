# 插件管理

从 `@vykor/daemon-admin/plugins` 使用 `PluginResource` 查询、启停、安装或链接本地插件、卸载和重载。daemon 管理插件记录、批准和运行时刷新，调用方呈现返回的状态和诊断。

新增跨产品共享的插件请求放在 `plugin-resource.ts`。Desktop 归档导入、市场、嵌入应用和窗口状态由 Desktop 对应功能负责。
