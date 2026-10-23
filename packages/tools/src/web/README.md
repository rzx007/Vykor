# 网页搜索与抓取

组织网络运行配置、搜索、抓取、网络限制和错误转换。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [default-runtime.ts](./default-runtime.ts) | `defaultWebRuntime` |
| [fetch.ts](./fetch.ts) | `createWebFetchTool`、`webFetchTool` |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [runtime.ts](./runtime.ts) | `WebRuntimeOptions`、`WebRuntime`、`htmlToText` |
| [sandbox-network.ts](./sandbox-network.ts) | `sandboxNetworkGuard` |
| [search.ts](./search.ts) | `createWebSearchTool`、`webSearchTool` |
| [tool-errors.ts](./tool-errors.ts) | `webErrorFacts`、`formatWebError` |
| [types.ts](./types.ts) | `WebProviderErrorCode`、`WebProviderAvailability`、`WebSearchSource` |

## 分类目录

| 目录 | 用途 |
| --- | --- |
| [providers/](./providers/README.md) | 实现具体的网页搜索和 HTTP 抓取方式。 |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

工具解析查询或 URL，运行配置选择可用提供方，完成搜索或抓取后整理内容与错误。

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
