# Desktop MCP Apps Main 宿主

`plugin-app-service.ts` 保存窗口 owner、原会话与经过服务端验证的应用 source、lease、工具目录；renderer 只得到 mountId、一次性文档 URL 和去掉 lease 的状态。初次 mount 要求原 Main 会话订阅 token；之后保留原会话来源，不以当前选择改目标。每次 prepare/执行仍由服务器验证当前授权。

`document-store.ts` 验证摘要并把内存 HTML 绑定到 Electron 实际 frame 身份；`resources.ts` 检查官方资源结构、URI、MIME、base64 和解码大小。`document-security.ts` 是整个 Electron session 唯一 onBeforeRequest owner，旧、新 scheme 显式注册，避免互相覆盖安全策略。原 window-policy 接受两个 store 的结构接口，保留导航、下载与退役 frame 限制。

`ipc.ts` 只接收已注册窗口的 mainFrame 调用。请求参数不能指定后台、lease、运行函数。工具参数在确认前独立有限 JSON 复制，Main 产生 requestId 并固定 controlRevision。invoke 丢失回应后只查原 receipt。`release` 只撤窗口 mount；只有 `close` 才用固定 expectedRevision 关闭 durable app。关闭时先暂停新准入/待确认，成功后再取消旧工作并销毁 frame；版本冲突保留草稿和原 frame，刷新回执但不自动换版本重放关闭。

后续消息功能可通过 `getBinding(ownerId, mountId)` 和 `assertBinding(binding)` 取得并复验同一个 Main 绑定；必须继续限制原会话和当前 canMessage/lease，并在确认前复制有限 JSON。
