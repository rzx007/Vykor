# 网络能力提供方

实现具体的网页搜索和 HTTP 抓取方式。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [duckduckgo-search.ts](./duckduckgo-search.ts) | `DuckDuckGoSearchProviderOptions`、`DuckDuckGoSearchProvider`、`parseDuckDuckGoSearchResults` |
| [http-fetch.ts](./http-fetch.ts) | `HttpFetchProviderOptions`、`HttpFetchProvider` |

## 入口与处理步骤

主要入口或定义见 [duckduckgo-search.ts](./duckduckgo-search.ts)。

运行时把请求交给提供方，提供方执行网络操作并解析响应，再返回统一格式的内容。

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

新增测试放在本目录的 `__test__/`；跨分类用例放在共同目录的 `__test__/`。
