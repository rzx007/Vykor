# MCP Apps 常驻页面

此目录拥有窗口级页面生命周期。`provider.tsx` 在根路由挂载，`page-manager.ts` 保存原会话与页面，`frame.tsx` 的 iframe 始终留在这个根节点；工具面板的 `panel.tsx` 只测量位置并改变 CSS，不使用 portal、不移动 DOM。

所有应用只在主工作区右侧面板展示。聊天中的具名入口打开或定位右侧标签，不创建聊天内显示区域；查看已有页面时不重放旧结果正文。未知结果由 Main 决定页面身份，不能凭相同资源地址合并不同入口。实时结果只更新原页面，由右上角工作摘要提示新应用；用户明确点击才展开右侧面板，不抢当前标签。历史消息渲染不会自动打开应用。面板使用应用支持的 inline 模式；仅支持 inline 的应用也可从目录打开，显示模式请求始终受面板边界约束。收起面板、切换应用或会话只隐藏页面，不销毁 iframe。

`transport.ts` 使用 ext-apps 1.1.2 的官方 `AppBridge(null, ...)` 和 `PostMessageTransport(peer, peer)`，一个 iframe 一套协议。`handlers.ts` 将官方工具、资源请求转到有限 preload；真实 MCP Client、lease 和执行函数留在 Main。`controller.ts` 先取得 Main 固定的请求，再显示宿主确认，等待原回执终态后返回完整 MCP result。主题和字体变化只更新 host context，其中正文和代码字体分别来自根元素的 `--font-sans`、`--font-mono`。

`queueInitial` 按源 Part 保存初始/模型工具结果，初始化后每个不同的成功 Part 发送一次；重复 Part 不再次通知。页面主动工具调用直接响应其 promise，不发送第二份 tool-result。官方 message/model-context/widgetState handler 继续固定原会话和后台；不能给页面增加自定义协议、自由选会话或执行函数。

窗口最多保留 8 个页面，同会话最多 4 个；超限拒绝新开。隐藏、切会话或切工具不释放草稿。显式关闭先暂停 Main 准入和确认，固定版本 durable close 成功后再取消原操作、查询回执并有界 teardown；版本冲突保留同 frame/草稿，等待明确重试；关闭某个窗口的 mount 不等同于关闭共享 durable app。断线保留 iframe，仅禁用操作；恢复查询原操作，不重新 invoke。unknown 由服务端持久事实控制，页面显示待核实并拒绝新工具/message。

测试放在 `__test__`；真实 Electron 入口为 `apps/desktop/tests/plugin-apps-electron/plugin-app-check.ts`，使用生产 Provider、Main IPC、官方 App 和独立真实后台。样式由用户查看，不包含截图或视觉预览。

旧 Native UI 已退役，历史记录只显示文字与停用提示；所有活页面由 `shell/plugin-apps` 使用官方 AppBridge 承载。
