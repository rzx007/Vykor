# 插件页面调用封装

通过 `@vykor/plugins/app-client` 或插件随包携带的 `app-client.mjs` 使用。`client.ts` 只包含浏览器可用的类型和函数，不加载插件安装、Node 或服务端代码。

`definePluginAppTool<Input, Output>(name)` 定义共享的工具名、参数和页面结构化结果类型；`createPluginAppClient(app).call(tool, input, options)` 仍调用官方 MCP Apps 的 `app.callServerTool()`。工具是否可用、权限、操作记录和回执继续由既有宿主执行链路处理。

封装不保存状态，不解析文本、不重试、不把 `isError` 改成异常。返回完整原始结果，`structuredContent` 仍可能缺失；类型提示不替代页面的业务校验。调用选项沿用传入 App 的类型，包括取消信号和超时。

测试放在 `__test__/`；公开类型用例放在包根 `__test__/app-client.type-test.ts`。新增页面调用辅助函数放在本目录。

独立插件使用自动生成的 `.mjs` 和 `.d.mts`，构建时打进离线 HTML，不依赖仓库路径。更新源码后在仓库根运行 `node scripts/sync-plugin-app-client.mjs`；`--check` 检查副本是否同步。
