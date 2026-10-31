# 浏览器工具接入

把浏览器宿主能力转换为 Agent 可调用的浏览器与开发工具。

## 入口与流程

宿主实现 `BrowserHost`；工具工厂把观察、操作和开发请求交给宿主，再把结果返回当前工具调用。

来源访问、敏感操作和开发检查统一使用 `ToolContext.requestPermission`，不把权限请求改成业务提问。核心执行器按本轮工具绑定重新检查禁止规则和会话授权：完全访问直接批准，普通模式保留具体操作确认；开发检查在普通模式下仍逐次确认。

`Browser` 工厂通过 Runtime 的可信身份登记能力，只把实际 `inspect` 动作登记为只读查询。Daemon 通过 Node 的 `options.tools` 接入它，实际来源为 `agent`。Server 在保存操作前核对本轮捕获的定义、执行函数、宿主来源和实际输入，因此未知写入后仍可观察页面状态；`navigate`、`click`、`type`、`scroll` 以及同名替换工具仍受到写入保护。查询成功不会改变旧操作的未知结果。

## 状态归属

浏览器标签页与页面状态由宿主管理；本目录负责输入输出转换和工具依赖。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [browser-developer-tool.ts](./browser-developer-tool.ts) | `BROWSER_DEVELOPER_MAX_RESULT_BYTES`、`createBrowserDeveloperTool` |
| [browser-host.ts](./browser-host.ts) | `BrowserAction`、`BrowserObservation`、`BrowserDeveloperAction`、`BrowserDeveloperResult` 等 |
| [browser-tool.ts](./browser-tool.ts) | `BrowserScreenshotStore`、`createBrowserTool` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |

## 测试与维护

新增浏览器动作及工具转换放在这里，实际浏览器控制由宿主实现。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
