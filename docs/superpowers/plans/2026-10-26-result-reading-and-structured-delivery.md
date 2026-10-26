# 长结果补读与结构化交付实施计划

> 状态：已按先文档后实现完成本轮范围并通过合并前审查，见[验收记录](../reviews/2026-10-26-result-reading-and-structured-delivery.md)；本轮通过 `main` 交付，S2 执行恢复暂缓。
> For agentic workers: 使用有明确文件边界的任务分工，先稳定合同，再实现与独立审查；测试先建立失败证据。

**目标：** 长工具结果截断后仍能按引用补读，daemon 重启后仍可读取；宿主需要机器可读结果时，Agent 通过统一工具提交经过结构校验的交付。

**架构：** 复用 S1 已保存的完整操作结果，不另建结果正文库或执行检查点。SDK 使用有容量上限的内存结果存储。结构化交付复用现有 AgentRunContribution 的工具注入和 endRunOnSuccess，当前 Run 结束仍沿用现有生命周期。

**技术：** 现有 TypeScript、ToolResult、QueryEngine、Kernel、Node 绑定、SessionStore 操作账本与消息投影；Vitest、真实临时 SQLite 与 SDK 打包检查。业务数据只走纯数据合同。

**依据：** [原方案 P1-A/P1-B](../specs/2026-10-26-agent-core-capability-completion-design.md#h1-p1-的明确范围)与用户本轮调整。本轮解除这两项对 S2/S3 的实施顺序依赖，不实现完整 P0。

## 范围与成本判断

- 本轮先交付两个可独立使用的能力，不恢复 S2 的 checkpoint、跨 Run 继续状态或 Workflow 调度。
- 涉及合同、core、Kernel/Node、Server/Services 接线及 SDK/协议消费者，预计超过 8 个文件；这来自现有分层，不新增运行控制层。
- 不新增数据库表、owner lease、环境变量或运行状态。daemon 的大正文仍以 S1 操作记录为准，避免复制完整正文到新表。
- 普通聊天不强制 JSON。结构化交付由可信宿主显式配置，公共 HTTP 只传数据 Schema，不能传函数或绕过业务核验。
- 本轮不做新结果管理界面，不主动搭建 UI 预览。通过工具、SDK 结果与已有 Run 元数据读取。

### 单 Agent 持久审批：本轮不纳入

当前 PermissionController 用内存 waiter 等待决定，启动时现有恢复路径过期 pending 审批并中断旧 Run。仅保留审批记录不能让被批准的操作恢复执行。

真正跨重启审批仍需保存准确待执行意图、重建可信工具绑定、重新检查当前授权、创建新 Run 并处理批准/取消竞争。单 Agent 可省去父子依赖，但省不去这些要求。本轮不将它当作小改顺带接入。

## Task 1：稳定引用与分页/检索

**文件：** agent-contracts 的 tools/result-data.ts 与纯数据公开入口、execution/execution.ts、tools/tools.ts、tools/tool-data.ts；core `engine/results/`；Services `tool-results/`；Server `application/session/execution/tool-result-service.ts`。

**合同：**

```ts
interface ToolResultRef {
  id: string; // 不透明引用；daemon 关联 S1 operationId，SDK 由内存存储生成
  toolName: string;
  totalChars: number;
}
interface ToolResultPage {
  ref: ToolResultRef;
  text: string;
  offset: number;
  nextOffset?: number;
}
interface ToolResultSearch {
  ref: ToolResultRef;
  matches: Array<{ offset: number; text: string }>;
  nextOffset?: number;
}
interface RunToolResultStore {
  retain(result: ToolExecutionResult, source?: { kind: string; id?: string }): Promise<ToolResultRef>;
  list(input?: { offset?: number; limit?: number }): Promise<{ items: ToolResultRef[]; nextOffset?: number }>;
  read(input: { id: string; offset?: number; limit?: number }): Promise<ToolResultPage>;
  search(input: { id: string; query: string; offset?: number; limit?: number }): Promise<ToolResultSearch>;
}
```

RunToolResultStore 在宿主中绑定实际 session、Run、当前工具集合和来源授权，不从模型输入取得授权身份。SDK/Kernel 通过 PreparedAgentRun.toolResults 或执行上下文接收能力。

- [x] 先写失败测试：超过原有 256 KB 限制仍可读取尾部；分页没有重复/遗漏；字面检索可定位尾部；非法游标与超限返回明确错误。
- [x] core 提供通用文本视图与有容量上限的内存实现；读取页最多 16000 字符，列表最多 100 项，检索最多 100 项，查询不执行正则。单个不可容纳结果应明确失败，不能生成读不到的成功引用。
- [x] Services 只读已有工具操作的完整结果，提供分页、字面检索与稳定引用解析；SQLite 重开仍可读，memory 会话不落库。测试放 `tool-results/__test__/`。
- [x] Server 绑定当前 session 与允许的实际工具来源；跨会话、未选插件、已撤销工具权限、伪造引用都不可读。不把结果正文当成系统指令。
- [x] 未知或未完成的调用不产生虚构完整结果；已保存错误结果可以作为历史数据补读。非文本内容仅报告类型，不把图片/base64 当文本分页。
- [x] 同一结果重复 retain 返回同一引用；普通清理不提前删除 S1 未决审计，明确删除会话后引用不可用。

```ts
const page = await reopened.read({ id: ref.id, offset: tailOffset, limit: 100 });
expect(page.text).toContain("TAIL-EVIDENCE");
await expect(otherSession.read({ id: ref.id })).rejects.toThrow();
```

## Task 2：接到模型、Node 与 daemon

**文件：** core query-engine、结果格式化与输出预算；tools 的 `results/` 与公开导航；Node 默认工具注册、准备能力与配置；Server daemon loader/application；已有 transcript 重建；相关测试。

**入口：** 一个内置 `ToolResult` 工具，action 为 list/read/search，提供同一存储的三种读取；不重新调用原外部工具。当前 Run 的旧 readToolResult 能力继续按原来源约束服务插件，不替换成无范围全库读取。

- [x] 先建立真实 QueryEngine 失败测试：大结果在模型截断前可靠保留，工具结果给出稳定引用与补读方法，尾部在下一回合仍可补读。
- [x] 默认 Node SDK 在 Agent 生命周期内跨 Run 复用有上限的内存存储；daemon 注入已有 S1 账本读取能力，重启后不依赖原函数身份。
- [x] 原工具结果完成事件仍保留完整内容及新引用；模型内联内容受现有预算限制，引用提示本身不能被截掉。保存失败不能静默丢正文后继续。
- [x] 历史压缩或重启后，可通过 list 找回当前有权访问的引用；旧模型历史仍可按原协议清理，不制造工具结果配对。
- [x] 结果查询能力不扩大原工具访问范围，S1 权限与强制规则保持生效。查询参数在派发前被拒绝时为 not_started；实际只读查询返回错误时为 completed + isError，不留下假写入 unknown。
- [x] 更新 SDK/模块 README 与测试索引，保留普通 SDK 和插件原接口回归。

## Task 3：工具式结构化交付

**文件：** agent-contracts `execution/delivery.ts` 及公开出口；Kernel `delivery/`、agent/framework-agent-run、Node 选项；core 现有工具 Schema 校验的纯执行公开入口；child 结果与 Server 完成投影。

**合同：**

```ts
interface StructuredDelivery {
  status: "done" | "partial" | "blocked" | "waiting";
  summary: string;
  data: unknown; // 运行时必须是有效 JSON，且通过宿主 resultSchema
}
interface DeliveryReceipt extends StructuredDelivery {
  validation: "schema_valid";
  verification: "not_requested" | "passed";
}
interface AgentOutputContract {
  schema: Record<string, unknown>;
  verify?(delivery: StructuredDelivery): Promise<{ ok: boolean; reason?: string }>;
}
```

输出合同使用 outputContract 名称，不占用现有 delivery=queue/steer 字段。宿主 Schema 采用当前工具校验器支持的子集；不支持的约束在配置时拒绝，不能假装支持完整 JSON Schema。

- [x] 先写失败测试：非法结构不产生 DeliveryReceipt，合法值经真实宿主核验后才标记 passed；没有核验器保持 not_requested，不能宣称业务验收通过。
- [x] 注入可信 SubmitResult 工具，Envelope 校验 status/summary/data，data 按宿主 Schema 校验。成功后利用原 endRunOnSuccess 结束工具批次，再正常结算 Run。
- [x] 复用现有工具输入纠错上限，失败给出可修改原因；核验拒绝不伪装为外部操作结果未知。合同存在但模型未提交有效交付时，Run 不返回伪成功。
- [x] 回合、超时、取消、S1 强制检查和原工具预算仍生效。业务核验器不会通过 HTTP 序列化传入。
- [x] AgentRunResult 与 AgentChildResult 可携带可信 receipt；纯文本 output 继续保留，普通任务不强制结构化。
- [x] run.completed 可携带 receipt，Server 写入现有 Run metadata。done 是 Agent 的交付状态，Run.completed 只表示本轮正常结束，不能自动完成 Goal 或替代业务核验。

```ts
expect(result.delivery).toMatchObject({ status: "done", validation: "schema_valid", verification: "passed" });
expect(unverified.delivery?.verification).toBe("not_requested");
```

## Task 4：公共入口、验收与收口

**文件：** Protocol/Client 的 prompt 输入与运行读取；Server 受理/执行接线；`tests/agent-integration/__test__/result-delivery.integration.test.ts`；模块文档、方案与验收记录。

- [x] 公开纯数据 outputSchema 入口；宿主显式启用时传入 outputContract，默认普通聊天保持原状。请求校验、幂等内容比较与已有客户端类型一并更新。
- [x] 真实 SQLite 重新打开后，模型能够检索并读取先前大结果尾部；跨会话和已撤销来源不能读取。结果正文不增加第二套持久副本。
- [x] fake model + 真实 Kernel/工具管道验证结构错误纠正、核验失败、无有效交付、成功收尾、child 结果、取消和未配置合同的旧行为。
- [x] 验证结果读取工具的返回也受预算限制，不能递归制造无界结果引用；引用不能成为任意路径/文件读取入口。
- [x] 运行受影响包类型、core/Kernel/Node/Services/Server 定向测试、打包与模块边界；按风险选测，不重复全仓测试。
- [x] 运行 `pnpm check:retired-ui`、`pnpm check-docs` 与差异检查；精确旧引用只调整已核实的原文行号。
- [x] 独立审查并修复问题，记录实际结果和未验证的平台。同步原 Markdown/HTML 的优先级与已实现边界。

本轮留在独立分支，不合并或推送。S2 撤回文档保留，不能误标为已实现。
