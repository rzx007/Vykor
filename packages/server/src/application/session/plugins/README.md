# 会话插件与应用操作

管理会话插件选择、能力授权、插件应用调用、通知与历史展示记录读取。

## 入口与流程

选择与策略模块确定本次运行可用能力；应用服务核对持久记录与可信宿主绑定，再执行操作或返回静态资源；历史展示记录仅供读取。

## 状态归属

插件选择与应用记录保存在会话和插件存储中，宿主授权由既有运行宿主持有，操作服务只协调当前请求。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [plugin-app-admission-error.ts](./plugin-app-admission-error.ts) | `PluginAppAdmissionError` |
| [plugin-app-assembly.ts](./plugin-app-assembly.ts) | `assemblePluginApps` |
| [plugin-app-conversation-service.ts](./plugin-app-conversation-service.ts) | `PluginAppConversationService` |
| [plugin-app-host-binding.ts](./plugin-app-host-binding.ts) | `pluginAppHostBinding`、`pluginAppHostInvocation` |
| [plugin-app-inputs.ts](./plugin-app-inputs.ts) | `parsePluginAppSource`、`parseOpenPluginAppInput`、`parseClosePluginAppInput`、`parsePluginAppToolRequest` 等 |
| [plugin-app-notifications.ts](./plugin-app-notifications.ts) | `PluginAppNotifications` |
| [plugin-app-operation-executor.ts](./plugin-app-operation-executor.ts) | `PluginAppOperationExecutor` |
| [plugin-app-operation-service.ts](./plugin-app-operation-service.ts) | `pluginAppRequestId`、`pluginAppFingerprint`、`verifiedAppAction`、`PluginAppOperationOptions` 等 |
| [plugin-app-policy.ts](./plugin-app-policy.ts) | `MAX_SESSION_PLUGIN_APPS` |
| [plugin-app-query-models.ts](./plugin-app-query-models.ts) | `PluginAppAvailability`、`PluginAppResponse`、`PluginAppListResponse`、`PluginAppActionResponse` 等 |
| [plugin-app-static-resources.ts](./plugin-app-static-resources.ts) | `verifiedStaticAppResources` |
| [plugin-lifecycle.ts](./plugin-lifecycle.ts) | `PluginLifecycleScope`、`PluginLifecycle` |
| [session-plugin-app-service.ts](./session-plugin-app-service.ts) | `PluginAppBackendDescriptor`、`SessionPluginAppCatalogue`、`PluginAppLeaseAuthority`、`PluginAppCurrentFacts` 等 |
| [session-plugin-capability-service.ts](./session-plugin-capability-service.ts) | `SessionPluginCapabilityServiceContext`、`SessionPluginCapabilityService` |
| [session-plugin-selection.ts](./session-plugin-selection.ts) | `InputPluginScope`、`RunPluginSelection`、`capturePluginSelectionPolicy`、`emptyPluginScope` 等 |

历史展示记录服务保留在本分类，只读取已保存的历史记录。迁移该服务时要同步专用依赖检查和历史引用清单。

## 测试与维护

会话范围的插件策略、绑定和应用操作放在这里；插件安装与市场实现放在 default-services/extensions。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
