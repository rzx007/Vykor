# 个性化与项目事实

提供记忆配置、规则查看和项目事实维护。

## 入口与流程

配置函数读取或保存个性化设置；项目事实服务对接项目事实存储，应用和 HTTP 路由读取其结果。

## 状态归属

记忆配置与规则由配置和个性化能力保存，项目事实通过注入的存储管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [personalization-settings.ts](./personalization-settings.ts) | `PersonalizationMemoryPreferences`、`inspectPersonalizationSettings`、`saveMemoryConfiguration` |
| [project-facts-service.ts](./project-facts-service.ts) | `ReplaceProjectFactInput`、`ProjectFactsContext`、`createProjectFactsService`、`ProjectFactsService` |

## 测试与维护

个性化设置与事实应用规则放在这里；会话结束后的记忆维护由 session/maintenance 触发。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
