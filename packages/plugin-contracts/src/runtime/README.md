# 运行期交接数据

定义插件与宿主之间传递的运行接口和可序列化数据。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [runtime-data.ts](./runtime-data.ts) | `PluginAppJson`、`PluginAppValidationErrorCode`、`PluginAppValidationError` |
| [runtime.ts](./runtime.ts) | `PluginAppHostBinding`、`PluginAppRuntimeLease`、`PluginAppRuntimeSource` |

## 入口与处理步骤

主要入口或定义见 [runtime-data.ts](./runtime-data.ts)。

插件宿主与消费方通过公开子路径引用相同定义，再按接口交换运行数据。

## 状态放在哪里

这里只保存类型、常量和纯函数定义；安装记录、文件内容及运行连接由消费方管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

新增测试放在本目录的 `__test__/`；跨分类用例放在共同目录的 `__test__/`。
