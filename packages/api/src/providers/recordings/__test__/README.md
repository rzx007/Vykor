# 录制设施测试

[http-recording.test.ts](http-recording.test.ts) 使用明确标记为 synthetic 的构造响应验证脱敏、秘密检测、严格请求匹配、消费状态和 required 缺失错误；构造响应不是供应商录制。

[capture-probe.test.ts](capture-probe.test.ts) 只验证探针初始化失败时的安全输出；读取全部由合成内容接管，fetch 被阻止。覆盖设置、凭据和 Codex 登录 JSON 损坏、头部初始化失败及路由校验，不读取真实凭据、不发请求、不写样本。

真实观测放 [fixtures/](fixtures/README.md)，由[集成测试](../../../../../../../tests/agent-integration/provider-recording-replay.integration.test.ts)经过实际 SDK / HTTP SSE 解码路径。测试状态只保存在每次回放的内存中，不读取用户凭据。新增设施测试继续放本目录；新供应商观测放 fixtures 并同步清单。
