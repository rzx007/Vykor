# MCP Apps 常驻页面

此目录拥有窗口级页面生命周期。`provider.tsx` 在根路由挂载，`page-manager.ts` 保存原会话与页面，`frame.tsx` 的 iframe 始终留在这个根节点；工具面板的 `panel.tsx` 只测量位置并改变 CSS，不使用 portal、不移动 DOM。

`transport.ts` 使用 ext-apps 1.1.2 的官方 `AppBridge(null, ...)` 和 `PostMessageTransport(peer, peer)`，一个 iframe 一套协议。`handlers.ts` 将官方工具、资源请求转到有限 preload；真实 MCP Client、lease 和执行函数留在 Main。`controller.ts` 先取得 Main 固定的请求，再显示宿主确认，等待原回执终态后返回完整 MCP result。主题变化只更新 host context。

`queueInitial` 按源 Part 保存初始/模型工具结果，初始化后每个不同的成功 Part 发送一次；重复 Part 不再次通知。页面主动工具调用直接响应其 promise，不发送第二份 tool-result。官方 message/model-context/widgetState handler 继续固定原会话和后台；不能给页面增加自定义协议、自由选会话或执行函数。

窗口最多保留 8 个页面，同会话最多 4 个；超限拒绝新开。隐藏、切会话或切工具不释放草稿。显式关闭先暂停 Main 准入和确认，固定版本 durable close 成功后再取消原操作、查询回执并有界 teardown；版本冲突保留同 frame/草稿，等待明确重试；关闭某个窗口的 mount 不等同于关闭共享 durable app。断线保留 iframe，仅禁用操作；恢复查询原操作，不重新 invoke。unknown 由服务端持久事实控制，页面显示待核实并拒绝新工具/message。

测试放在 `__test__`；真实 Electron 入口为 `tests/plugin-apps-electron/plugin-app-check.ts`，使用生产 Provider、Main IPC、官方 App 和独立真实后台。样式由用户查看，不包含截图或视觉预览。

旧 Native UI 已退役，历史记录只显示文字与停用提示；所有活页面由 `shell/plugin-apps` 使用官方 AppBridge 承载。
