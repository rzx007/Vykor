# 桌面浏览器

- [ipc.ts](./ipc.ts) 处理标签页绑定和批注。它从 IPC 发送者识别所属窗口。
- [browser-bridge.ts](./browser-bridge.ts) 在桌面主进程连接本机后台的私有事件流。每次操作单独发送审批和结果。桌面发现结果超限时只回传简短错误，后台也会拒收超限回包并结束对应请求。事件流继续处理其他请求。断流时取消请求并停止开发诊断。
- [browser-agent-service.ts](./browser-agent-service.ts) 保存标签页归属、当前页版本、元素和站点授权。它按顺序执行浏览器操作，在审批和执行之间核对窗口订阅和页面。
- [browser-developer-inspector.ts](./browser-developer-inspector.ts) 执行固定的开发检查并保存诊断采集状态。[browser-annotation-controller.ts](./browser-annotation-controller.ts) 保存当前页面的用户批注。

后台发来的操作从桥接入口进入，传给浏览器服务执行，再由桥接代码回传结果。新增桌面浏览器操作放在服务或相应检查模块。浏览器与后台之间的消息类型放在服务端的浏览器工具目录。测试放在本目录的 `__test__/`。
