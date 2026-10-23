# 浏览器工具接入

把浏览器宿主能力转换为 Agent 可调用的浏览器与开发工具。

## 入口与流程

宿主实现 `BrowserHost`；工具工厂把观察、操作和开发请求交给宿主，再把结果返回当前工具调用。

## 状态归属

浏览器标签页与页面状态由宿主管理；本目录负责输入输出转换和工具依赖。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [browser-developer-tool.ts](./browser-developer-tool.ts) | `BROWSER_DEVELOPER_MAX_RESULT_BYTES`、`createBrowserDeveloperTool` |
| [browser-host.ts](./browser-host.ts) | `BrowserAction`、`BrowserObservation`、`BrowserDeveloperAction`、`BrowserDeveloperResult` 等 |
| [browser-tool.ts](./browser-tool.ts) | `BrowserScreenshotStore`、`createBrowserTool`、`isBrowserPermissionApproved` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |

## 测试与维护

新增浏览器动作及工具转换放在这里，实际浏览器控制由宿主实现。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
