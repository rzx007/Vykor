# 浏览器工具

内嵌浏览器导航、样式注入、截图与标注。

## 放置边界

浏览器专属交互集中于此；独立图片编辑和预览使用 image-viewer。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

`BrowserTool` 明确接收当前输入框的 `composerScope`。保存成功后，`useBrowserAnnotations` 只通过 `onSaved` 发布本次新增的批注，加入原聊天草稿；浏览器删除成功通过 `onRemoved` 移除对应待发送批注。轮询和重新挂载只更新页面展示，不把历史批注重新加入输入框，因此不会覆盖用户在输入框修改过的意见，也不会复活已清空的草稿包。

保存和删除请求在开始时保留所属输入框。`BrowserTool` 在界面提交后更新当前归属标识，并在切换或卸载时撤销，尚未提交的渲染不会使当前请求失效。已有聊天的晚到结果仍更新原聊天；新聊天一旦离开或草稿被迁移、删除，状态监听会立即撤销旧标识，再次进入同名的新聊天也不会接收旧结果。

## 主要文件

- [browser-tool.tsx](browser-tool.tsx)
- [use-browser-annotations.ts](use-browser-annotations.ts)
- [browser-annotation-context.ts](browser-annotation-context.ts)：将待发送批注转换为 agent 可读的上下文，并解析历史批注供聊天摘要和编辑使用。
- [browser-navigation.ts](browser-navigation.ts)
- [browser-load-failure.ts](browser-load-failure.ts)：把本地文件、网络、证书、HTTP 状态与页面进程退出原因转成对应说明；显示地址时解码本地路径并移除网址中的账号密码。
- [browser-error-page.tsx](browser-error-page.tsx)：复用 Empty 和胶囊按钮，显示错误说明、失败地址、错误码，以及重新加载、返回和 HTTP 原网页入口；长地址换行，低高度时滚动，颜色跟随主题。

## 页面加载失败

`BrowserTool` 按 [Electron webview 导航事件](https://www.electronjs.org/docs/latest/api/webview-tag#dom-events) 处理当前主页面：`did-frame-navigate` 提供 HTTP 状态，`did-fail-load` 提供文件与连接错误，`render-process-gone` 提供页面进程退出原因。iframe 等子资源失败和主动取消不会覆盖整页。错误保存在当前浏览器实例中，最终的 loading/title 事件不会清掉错误或把失败地址改成内部空白页。

重新加载明确重试失败地址；HTTP 错误可以查看仍保留的原网页，不额外导航，也不绕过证书校验。开始下一次主导航时清理错误，新页面提交前若取消则恢复旧文档或旧错误；旧导航的迟到结果和卸载后的事件不能覆盖新页面。失败页暂停截图和批注，正常页面恢复后重新可用。非法地址会显示输入提示，不写入 webview 的地址属性。截图与浏览器绑定等操作错误继续使用原有的局部提示。

## 批注随消息发送

保存页面批注后，本次新增的记录自动加入所属聊天的输入框草稿。输入框上方显示批注数量；悬停、聚焦或点击可查看并修改待发送意见、删除单条或移除整包。轮询和重新挂载不会把已经移除的批注加回来。

发送时直接使用输入框中的批注包，记录各条批注的网址、目标、定位规则和意见；不截图，也不在发送时补读页面记录。聊天气泡显示可展开的批注摘要，定位规则和序列化文本只供 agent 使用。

编辑入口调用 `stripBrowserAnnotationContext(items, sourceItems)`，从原消息末尾边界完整、JSON 格式有效的快照提取原文，在编辑消息中从后往前精确移除一次，因此快照后新增的正文和引用都能保留。未提供原消息或原消息没有有效快照时，只尝试移除编辑消息末尾的有效快照，不删除正文中间手写的批注示例；原消息条目均不修改。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
