# Client 阶段 5D：Session Resource 实现计划

> **面向 AI 代理的工作者：** 先完成 Session Resource、兼容转发和窄调用方改造，阶段末统一运行测试。

**目标：** 将 Session、Prompt、Goal 和 Session utility endpoint 迁入 SessionResource，并让 commands/sync 不再依赖完整 OpenHarnessClient。

**架构：** SessionResource 只做请求映射；Session commands 保留用户命令规则；state sync 保留 replay+live 对账。createPromptRequestId 保持 caller-stable。

**技术栈：** TypeScript、HttpTransport、Sse/Event Resource capability、Client state。

---

## 方法范围

- Session CRUD/fork/archive/delete。
- getState、listMessages、listMessageParts。
- admit/edit/promote/cancel/resume/interrupt。
- compact/rewind/remember/export/usage。
- Goal get/create/update/action。

## 批量实现

- [ ] 创建 resources/session-resource.ts。
- [ ] 定义 SessionResourceTransport，只用 HttpTransport。
- [ ] 原样迁移全部路径、body、query、decoder、status 和 signal。
- [ ] createPromptRequestId 保留公共函数；自动 id 的调用时机不变。
- [ ] attachment ordered refs、delivery、plugin/skill items 不重排。
- [ ] edit/promote/cancel/resume 返回类型保持。
- [ ] Goal null/record、expected revision/action body 保持。
- [ ] OpenHarnessClient 暴露 sessions，旧 Session/Goal/utility 方法全部转发。
- [ ] 修改 commands/session-commands.ts 的 host 接口为 Pick<SessionResource,...> 或明确 SessionCommandClient。
- [ ] 修改 state/sync.ts，只依赖 getSessionState/listEvents/streamEvents 所需 capability，不接完整 Client。
- [ ] 不改 reducer、busy、selected session 或 Slash command 语义。
- [ ] 快检 Client、CLI、Frontend/ Desktop 受影响类型。
- [ ] 提交：refactor(client): extract session resource and narrow consumers

## 统一测试清单

- CRUD 编码；
- prompt id、queue/steer、attachment 顺序；
- edit/promote/cancel/resume/interrupt；
- Goal 四入口；
- snapshot/messages/parts pagination；
- compact/rewind/remember/export/usage；
- commands 与 sync 用最小 fake；
- facade 和 Resource 结果一致。

## 审核重点

Resource 不拥有 UI 状态；commands/sync 真正窄化；request id 时机不变；旧 Client 无 Session endpoint 实现。
