# 浏览器工具接入

把浏览器宿主能力转换为 Agent 可调用的浏览器与开发工具。

## 入口与流程

宿主实现 `BrowserHost`；工具工厂把观察、操作和开发请求交给宿主，再把结果返回当前工具调用。

独立 daemon 使用 `DesktopBrowserBridge` 作为宿主。它通过本机私有 SSE 向桌面发送操作，桌面通过同一连接和请求标识提交审批请求与操作结果。审批继续由本次工具调用的权限回调处理。没有桌面连接时返回工具不可用；已经派发的操作在断线时标记结果未知，重新连接后只接收新操作。

`Browser inspect` 还会返回当前页面已保存的批注：`target` 说明批注对应的页面元素，`comment` 是用户意见，`selector` 是定位该元素的 CSS 选择器。用户消息已携带批注时直接使用；用户提到批注但消息未携带时，先读取当前页面，再判断是否缺少批注。

来源访问、敏感操作和开发检查统一使用 `ToolContext.requestPermission`，不把权限请求改成业务提问。核心执行器按本轮工具绑定重新检查禁止规则和会话授权：完全访问直接批准，普通模式保留具体操作确认；开发检查在普通模式下仍逐次确认。

浏览器通过 Node 的 `options.tools` 注册，实际来源为 `agent`。帮我批准模式按这个宿主捕获的来源进入自动审查，不会因它不是 `builtin` 就直接要求人工确认；同一会话相关运行内已保存的浏览器结果也作为风险参考提供给审查器。来源身份与页面内容都不会直接批准操作，敏感操作仍按具体用户指令和审查结果处理。

`Browser` 工厂通过 Runtime 的可信身份登记能力，只把实际 `inspect` 动作登记为只读查询。Daemon 通过 Node 的 `options.tools` 接入它，实际来源为 `agent`。Server 在保存操作前核对本轮捕获的定义、执行函数、宿主来源和实际输入，因此未知写入后仍可观察页面状态；`navigate`、`click`、`type`、`scroll` 以及同名替换工具仍受到写入保护。查询成功不会改变旧操作的未知结果。

## 状态归属

Electron 管理浏览器标签页与页面状态。独立 daemon 在内存中保留当前桌面连接和待完成请求，取消或停机时一起清理。截图字节经现有附件流程入库。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [browser-bridge.ts](./browser-bridge.ts) | 把浏览器调用转给已连接的桌面，匹配审批和结果 |
| [browser-bridge-protocol.ts](./browser-bridge-protocol.ts) | 定义并解析桌面接收的连接、命令和取消消息 |
| [browser-developer-tool.ts](./browser-developer-tool.ts) | `BROWSER_DEVELOPER_MAX_RESULT_BYTES`、`createBrowserDeveloperTool` |
| [browser-host.ts](./browser-host.ts) | `BrowserAction`、`BrowserObservation`、`BrowserDeveloperAction`、`BrowserDeveloperResult` 等 |
| [browser-tool.ts](./browser-tool.ts) | `BrowserScreenshotStore`、`createBrowserTool` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |

## 测试与维护

新增浏览器动作及工具转换放在这里，实际浏览器控制由宿主实现。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
