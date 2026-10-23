# 插件安装工具

把插件安装操作接入当前应用，并在需要时请求安装确认。

## 入口与流程

`plugin-install-tool.ts` 组装安装工具，确认辅助函数与应用权限能力协作，再交给插件服务完成实际操作。

## 状态归属

插件内容由插件服务管理，确认状态归属当前权限请求与会话。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [ask-install-confirmation.ts](./ask-install-confirmation.ts) | `askInstallConfirmation` |
| [plugin-install-tool.ts](./plugin-install-tool.ts) | `createPluginInstallTool` |

## 测试与维护

面向 Agent 的安装工具和确认衔接放在这里；默认安装实现放在 default-services/extensions，会话授权放在 session/plugins。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
