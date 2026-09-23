# 桌面浏览器 Agent 一期设计

## 目标

让桌面 Agent 操作 OpenHarness 现有浏览器面板中的页面，并能基于截图和页面结构检查结果。二期再提供显式开启的完整 CDP 调试能力。

## 一期范围

- 复用现有 Electron `<webview>`、标签页和登录状态。
- Agent 可查看活动标签页 URL、标题、可见页面结构与截图，并执行导航、点击、输入和滚动。
- 每组动作后重新观察页面；操作结果和页面错误返回给 Agent。
- 用户可选中页面元素并添加文字标注，标注内容随页面上下文交给 Agent。
- 首次访问新站点前请求用户授权；提交表单、付款、删除等高影响动作前请求确认。
- Agent 只能调用固定浏览器动作，不提供任意 JavaScript 执行入口。
- 不采集 Console、Network、Cookie 或其他浏览器内部信息；这些留给二期 Developer mode。

## 数据流

1. Server 应用层定义 `BrowserHost` 宿主接口和 Browser 动作类型，并对 Desktop 公开；Electron 主进程实现此接口。
2. 桌面 Renderer 将 `<webview>` 的 tab ID 与 Electron guest WebContents ID 绑定给主进程，并展示标注模式。
3. Server 始终在组装 Agent Runtime 时创建业务层 `Browser` 工具。Desktop 启动内嵌 daemon 时注入 `BrowserHost`；没有宿主时，工具描述明确标记不可用，执行入口返回受控错误。
4. Browser 工具经 `BrowserHost` 执行页面导航、可见结构提取和输入操作。截图字节由 Server 存入现有附件库，再以视觉输入返回模型。
5. 每次导航在新 origin 获得一次用户授权；高影响动作由宿主检查目标后暂停并等待用户确认。

## 运行范围

Server 始终注册业务层 Browser 工具。没有桌面 Browser Host 的 CLI 或独立 daemon 会显示明确的运行环境不可用描述；即使模型仍调用，工具也返回受控错误，不执行操作。

## 安全边界

- Web 页面继续运行在隔离、沙箱化的 `<webview>` 中。
- Renderer 到主进程的消息校验 sender，并将 tab ID 绑定到主进程实际观察到的 guest WebContents。
- Agent 不可传入 JavaScript、任意 CDP 方法或原始键盘事件序列。
- 浏览器内容作为不可信输入；网站文本不能改变 Agent 的权限或用户指令。
- 截图限制为 8 MB，并存入 Server 现有附件库；工具结果不包含 Cookie、Authorization Header 或网络请求正文。

## 二期边界

新增单独的 Developer mode 开关。获得显式授权后，才允许经 CDP 检查 DOM/样式、Console 和 Network。二期单独定义数据脱敏、保留范围和网站权限策略，不扩大一期 Browser 工具权限。

## 成功标准

- Agent 能在桌面面板打开用户指定的本地或公开页面。
- Agent 能读取页面状态、点击/输入/滚动并通过新观察判断动作是否生效。
- Agent 能看到截图并理解用户对页面元素添加的标注。
- 没有浏览器宿主的 CLI 或独立 daemon 会看到不可用说明；即使模型仍调用，工具也返回受控错误且不会访问页面。
- 任意页面脚本执行、完整 CDP 和浏览器内部数据读取不在一期接口中。
