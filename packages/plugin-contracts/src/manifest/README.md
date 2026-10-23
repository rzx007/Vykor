# Manifest 公共字段

定义插件 manifest、公用限额及字段检查。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [limits.ts](./limits.ts) | `PLUGIN_APP_MANIFEST_LIMITS`、`PLUGIN_APP_RESOURCE_LIMITS`、`PLUGIN_APP_DATA_LIMITS` |
| [manifest.ts](./manifest.ts) | `PluginAppResourceDefinition`、`PluginAppNativeToolDefinition`、`PluginAppToolPolicyDefinition` |
| [validation.ts](./validation.ts) | `ValidationResult`、`isPluginAppResourceUri`、`validatePluginAppManifest` |

## 入口与处理步骤

主要入口或定义见 [limits.ts](./limits.ts)。

来源和安装模块引用这些定义，对输入字段与限额执行纯校验，再决定是否进入后续处理。

## 状态放在哪里

这里只保存类型、常量和纯函数定义；安装记录、文件内容及运行连接由消费方管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
