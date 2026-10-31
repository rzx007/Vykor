# 插件安装工具

把插件安装操作接入当前应用，通过统一权限入口取得本次安装授权。

## 入口与流程

`plugin-install-tool.ts` 先让插件服务预览来源，拿到插件身份、内容摘要和申请权限，再调用 `ToolContext.requestPermission`。统一权限策略决定直接批准、拒绝或等待用户；批准后仍用预览时的摘要固定待安装内容，交给插件服务完成安装，最后刷新活动运行。安装确认不再借用 `AskUser` 提问入口。

## 状态归属

插件内容由插件服务管理，审批状态归属当前权限请求与会话。工具只在当前调用中保存预览结果；权限拒绝、过期或运行取消时不安装。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [plugin-install-tool.ts](./plugin-install-tool.ts) | `createPluginInstallTool` |

## 测试与维护

面向 Agent 的安装工具和确认衔接放在这里；默认安装实现放在 default-services/extensions，会话授权放在 session/plugins。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
