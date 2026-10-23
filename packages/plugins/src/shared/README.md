# 插件共享类型与诊断

提供加载、安装和激活共同使用的数据类型与诊断结构。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [diagnostics.ts](./diagnostics.ts) | `PluginDiagnosticSeverity`、`PluginDiagnosticPhase`、`PluginDiagnostic` |
| [types.ts](./types.ts) | `NATIVE_PLUGIN_COMPONENT_KINDS`、`NativePluginComponentKind`、`NativeToolComponent` |

## 入口与处理步骤

主要入口或定义见 [diagnostics.ts](./diagnostics.ts)。

各阶段引用相同组件、权限和诊断定义，构造结果后交回上层流程。

## 状态放在哪里

安装文件和安装记录由 installation 管理；加载与激活结果、运行期实例由调用方管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

新增测试放在本目录的 `__test__/`；跨分类用例放在共同目录的 `__test__/`。
