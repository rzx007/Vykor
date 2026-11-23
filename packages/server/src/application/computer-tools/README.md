# Computer Use 的 daemon 端

本目录把已授权的 Desktop 用户输入绑定到一次运行，并把该运行的 Computer 工具调用送回本机 Desktop。Desktop 负责核对要操作的窗口和输入许可。

## 调用入口

1. [Computer 私有路由](../../http/routes/computer-host.ts) 在认证后接收 Desktop 的事件流和用户输入。普通提交仍通过原有会话路由。
2. [computer-tool.ts](computer-tool.ts) 在新输入与运行入队前绑定会话、运行和输入的真实 ID。执行时再次核对当前连接、本次运行和调用来源，并遵守会话工具策略。Desktop 负责应用和窗口许可，遇到高影响动作时由会话审批服务请求真人确认。
3. [computer-bridge.ts](computer-bridge.ts) 通过事件流发出命令，并用同一连接和请求编号接收结果。`open_app` 接收应用名称或本轮引用，可附已打开的窗口或文档提示。`observe` 由 Desktop 复查当前目标。应用启动来源、就绪窗口和选择都由 Desktop 核对。 [私有消息定义](computer-bridge-protocol.ts)
4. [computer-approval.ts](computer-approval.ts) 在发起命令时记住运行、输入和配置修订。审批请求只绑定到当前命令，回复需要同一连接和会话。启动应用、语义操作和前台控制都要在派发前经私有 `dispatch` 核对运行授权。一次请求只能取得一次派发确认。
5. `capture` 的结果包含范围和大小已经核对的窗口图像。工具把图像放在内存，Core 只给通过检查的一次模型请求附图。Desktop 通过私有 `revoke-image` 按截图请求编号撤销，迟到的撤销只影响这张截图。聊天记录、工具归档和导出沿用文字结果。 [模型图片处理](../../../../api/src/providers/media/native-image-payload.ts) · [模型请求构造](../../../../core/src/engine/query-engine.ts)

## 状态归属

运行和审批沿用现有记录。普通客户端可以看到审批卡片，只有可信 Desktop 能提交 Computer 确认。每次 Desktop 连接和它允许的运行只在内存中保存。桥一次只等待一个命令结果。Stop、断线或超时会使未决审批过期，并拒绝迟到的回复。已派发动作的效果可能未知。运行结束时同一事件流下发会话、运行、输入三项标识，Desktop 据此撤销本轮余下权限。重连分配新编号，旧运行不会获得新连接的许可。

## 添加代码

工具参数和运行授权放在 `computer-tool.ts`，桥消息及校验放在 `computer-bridge-protocol.ts`，连接与取消放在 `computer-bridge.ts`。需要验证 HTTP 认证、断线和迟到结果时，补到 [私有路由测试](../../http/__test__/computer-host.test.ts)。
