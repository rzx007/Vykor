# 原生插件加载与安装源码导航

校验原生插件，读取组件，维护安装状态，并把可用能力交给运行时。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [sdk.ts](./sdk.ts) | `NativeToolPluginIdentity`、`NativeToolRegistrationContext`、`NativeToolInvocationContext` |

## 分类目录

| 目录 | 用途 |
| --- | --- |
| [activation/](./activation/README.md) | 将已加载的插件组件转换成运行时可注册的能力。 |
| [components/](./components/README.md) | 读取插件声明的 Agent、Skill、Hook、MCP、Tool 和应用资源。 |
| [installation/](./installation/README.md) | 维护安装路径、版本缓存、安装记录、完整性检查和安装执行。 |
| [loading/](./loading/README.md) | 组织原生插件 manifest 校验及组件读取。 |
| [manifest/](./manifest/README.md) | 检查原生插件 manifest 的结构和字段。 |
| [shared/](./shared/README.md) | 提供加载、安装和激活共同使用的数据类型与诊断结构。 |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

先校验 manifest，再读取声明的组件；安装流程维护缓存和记录，激活流程将组件交给上层使用。

## 状态放在哪里

安装文件和安装记录由 installation 管理；加载与激活结果、运行期实例由调用方管理。

## 新代码与测试

根目录保留包入口和分类导航；具体实现放入对应分类。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
