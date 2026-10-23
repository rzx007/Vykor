# 插件激活

将已加载的插件组件转换成运行时可注册的能力。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [activate.ts](./activate.ts) | `NativePluginActivationContext`、`NativePluginActivationResult`、`activateNativePlugin` |

## 入口与处理步骤

主要入口或定义见 [activate.ts](./activate.ts)。

调用方提供加载结果与上下文，激活函数准备组件与相关信息，再交还宿主注册和使用。

## 状态放在哪里

安装文件和安装记录由 installation 管理；加载与激活结果、运行期实例由调用方管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

新增测试放在本目录的 `__test__/`；跨分类用例放在共同目录的 `__test__/`。
