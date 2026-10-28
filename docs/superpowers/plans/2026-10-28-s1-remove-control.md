# S1 控制层移除实施计划

> 状态：实现与独立 review 已完成，2026-10-28。[验收记录](../reviews/2026-10-28-s1-remove-control.md)列出检查与限制；实际提交和合并状态以 Git 记录为准。

设计依据：[S1 彻底简化方案](../specs/2026-10-28-s1-simplification-design.md)。基线 main 为 `b714d3e702e4a719a671a33ec438f605abc9231f`；工作区分支为 `codex/s1-remove-control`。

## Global Constraints

- 彻底删除 S1 操作控制、票据、审计、人工核对、只读例外和迟到补写；不改名重建同类 Gate。
- 正常权限、审批、沙箱、派发前宿主实时检查和真实调用结束等待必须保留；覆盖模型、手动、嵌套和子运行。
- 长结果直接存入独立结果库，正文先保存再截断；新结果可重开补读，旧记录和引用不兼容。
- 增量迁移仅在测试数据库验证；不打开或改写用户实际数据库、配置或正在运行的后台。
- 保留真实 Run/Job/Task、附件、消息与正常终态投影恢复；不做整库重置。
- 使用真实行为回归测试与适当类型/文档/API 检查；不要为旧控制机制保留兼容测试或空接口。
- 允许本地提交作为 review 依据；不得 merge、push 或发布。主工作区已有改动不动。

### Task 1: 完整替换 S1 为当前检查与结果存储

阅读设计文档作为需求依据。以下改动需要作为一个完整交付批次完成，中间本地提交不表示可以单独发布。

1. 先补可观察行为回归，确认旧实现不能满足新结果存储或普通错误继续工作；记录红绿证据。已有普通权限与收尾测试也应复用。
2. Agent Contracts 和 Runtime 移除 AgentToolSafety、Operation/Attempt、旧 RequiredPolicyGate 的耦合；用单次派发前宿主检查保留当前 owner、Run、来源、输入/cwd、最终工具绑定与权限修订验证。普通 SDK 不强制持久化。
3. Services 用唯一 tool_result 表和现有 SessionStore 事务保存完整正文，Reader 不再依赖旧账本。移除三张 S1 表及其镜像、加载、mutation、恢复、清理与公开导出；新结果引用是 result:<UUID>，旧格式不兼容。
4. Core 删除多阶段状态机、失败派发记忆与迟到审计；合法完整错误返回保留 completed+isError，unknown 不阻止其他新调用。真实调用 Promise 仍登记到结束。
5. Server 切换结果存储和派发检查、投影身份，删除 Operation/Review Service、路由与专用观察集合；Client、Protocol、Domain Contracts 和 Host Config 清理旧 API/配置并递增协议。
6. 更新相关模块 README、主题手册与旧计划状态链接；保持文档中实现与提案状态准确。
7. 运行受影响定向测试、pnpm check-types、pnpm check:client-api、pnpm check-docs、pnpm check:retired-ui；重建所需内部包，运行实际 Node 装配的 Browser 失败后继续工作、Job 读取/等待及正常权限拒绝用例。所有临时效果限在测试目录。
8. 自查 diff，写完整报告并作本地提交。不得自行派 reviewer 或其他子代理。

### Task 2: 独立 review 与修复

由主代理交给独立 reviewer 检查 Task 1 的需求符合度与代码质量，再检查整条分支。重点是没有留下替代控制层、所有入口权限不可绕过、实际调用不会提前释放、补读来源校验与保存失败行为正确、没有历史兼容残留。修复重要问题后做对应复核。

## 验收与交付

以设计的验收表为准，报告实际通过与受环境影响的项目，不能把未运行或失败说成通过。交付工作区分支、提交、检查证据和 review 结论；未经新的指示不合并主分支或推送。
