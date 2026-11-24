# Computer Use 的 daemon 端

本目录把已授权的 Desktop 用户输入绑定到一次运行，并把该运行的 Computer 工具调用送回本机 Desktop。Desktop 负责核对要操作的窗口和输入许可。

## 调用入口

1. [Computer 私有路由](../../http/routes/computer-host.ts) 在认证后接收 Desktop 的事件流和用户输入。普通提交仍通过原有会话路由。
2. [computer-tool.ts](computer-tool.ts) 在新输入与运行入队前绑定会话、运行和输入的真实 ID。执行时再次核对当前连接、本次运行和调用来源，并遵守会话工具策略。Desktop 负责应用和窗口许可，动作审批沿用当前会话的授权模式。
3. [computer-bridge.ts](computer-bridge.ts) 通过事件流发出命令，并用同一连接和请求编号接收结果。`open_app` 接收应用名称或本轮引用，可用窗口提示定位已有文档，或用 `newWindow` 明确请求独立窗口。应用启动来源、就绪窗口和选择都由 Desktop 核对。 [私有消息定义](computer-bridge-protocol.ts)
4. [computer-approval.ts](computer-approval.ts) 在发起命令时记住运行、输入和配置修订。桌面和后台共用动作审批规则。完全访问的动作可直接申请派发，后台仍须在私有 `dispatch` 核对当前运行与权限。需要等待的审批只绑定到当前命令，回复需要同一连接和会话。
5. `capture` 的结果包含范围和大小已经核对的窗口图像。普通捕获仅在内存为通过检查的一次模型请求附图。Desktop 通过私有 `revoke-image` 按截图请求编号撤销，迟到的撤销只影响这张截图。 [模型图片处理](../../../../api/src/providers/media/native-image-payload.ts) · [模型请求构造](../../../../core/src/engine/query-engine.ts)
6. `capture` 指定 `purpose: "result"` 时暂存本轮的结果图。运行完成且截图仍有效时，通过现有附件服务保存并追加到最终助手消息。中断、断线或撤销会取消转存。有效截图因存储出错未能保存时，助手消息显示失败提示，文字回答继续保留。 [会话投影](../session/transcript/transcript-projection.ts)

## 状态归属

运行和审批沿用现有记录。普通客户端可以看到审批卡片，只有可信 Desktop 能提交 Computer 确认。每次 Desktop 连接和它允许的运行只在内存中保存。桥一次只等待一个命令结果。Stop、断线或超时会使未决审批过期，并拒绝迟到的回复。已派发动作的效果可能未知。运行结束时同一事件流下发会话、运行、输入三项标识，Desktop 据此撤销本轮余下权限。重连分配新编号，旧运行不会获得新连接的许可。

无法确认动作结果时，后台通过派发记录区分未派发与待核对。待核对的原动作留在历史；继续操作前，`computer-tool.ts` 要求成功观察控件，或要求有效的窗口截图已随模型请求送达。图片被撤销、被纯文本模型省略或在重试中移除时，需要新的核对依据。Computer 和内置 Browser 的命令在同一工具批次按顺序执行，桌面负责交接前台输入。

## 添加代码

工具参数和运行授权放在 `computer-tool.ts`，桥消息及校验放在 `computer-bridge-protocol.ts`，连接与取消放在 `computer-bridge.ts`。需要验证 HTTP 认证、断线和迟到结果时，补到 [私有路由测试](../../http/__test__/computer-host.test.ts)。
