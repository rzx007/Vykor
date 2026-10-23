# 插件加载入口

组织原生插件 manifest 校验及组件读取。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [load-native-plugin.ts](./load-native-plugin.ts) | `loadNativePlugin` |

## 入口与处理步骤

主要入口或定义见 [load-native-plugin.ts](./load-native-plugin.ts)。

接收插件根目录，校验 manifest，调用组件读取模块，最后返回已加载组件和诊断信息。

## 状态放在哪里

安装文件和安装记录由 installation 管理；加载与激活结果、运行期实例由调用方管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
