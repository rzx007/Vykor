# Protocol 分层收敛分阶段实施计划

> 状态：2026-10-22，P7–P13 实现与集中验收完成；当前阶段 P13，stageExceptions 为空。用户已连续授权后续阶段，无需逐阶段确认；按用户要求纳入本次 P7–P13 整体提交，未推送或发布。`01035993` 是迁移前业务基线。
> **For agentic workers:** 按已有连续授权执行 P8-P13，不在阶段之间增加审批。仅在用户或适用指令明确授权时使用子 Agent；本计划不要求自动委派。

**Goal:** 让 Protocol 只拥有通信格式，能力与领域数据各有规范来源，清除底层对通信层的依赖。

**Architecture:** 新增 json-data、plugin-contracts、domain-contracts 三个窄契约包；Jobs/Terminal 在原包建立纯数据入口。Server 显式转换通信输入、应用输入和存储命令，Node 接收已核实的宿主绑定。

**Tech Stack:** TypeScript、pnpm workspace、Vitest、现有 AST 架构检查、esbuild metafile 与 SDK pack 验证。

**Spec:** [Protocol 分层收敛方案](../specs/2026-10-22-protocol-layering-design.md)。类型、校验和策略的归属以方案第 4 节为准。

## 约束、顺序与检查策略

- 延续阶段编号 P7–P13，避免与已完成 P0–P6 混淆。P7 建立新边界的精确过渡例外；P0–P6 已退役关系不能借此恢复，P13 再次清零。
- 不改 HTTP 版本 5、字段/错误含义、SQLite schema、持久文件格式、权限默认值或运行生命周期。不增加第三方库，不重置数据。
- agent-contracts 只接收方案列明的执行权限类型与 MCP 数据常量。新公共类型先判断所有者，不能默认追加到任意根入口。
- 每阶段优先完成代码与调用方，统一运行该阶段相关验证后再更新记录；真实行为缺陷先用一个失败回归确认。配置与转发声明不写镜像测试。
- 不为每阶段运行全仓测试；复用前阶段未受影响的证据。最终按验收矩阵集中验证，只有发现未覆盖的跨域影响才扩大范围。
- 纯数据入口必须同时通过模块闭包和包级依赖检查。Client 的直接依赖保持 Protocol，规范声明来源只允许指定数据子路径。

| 阶段 | 交付 | 删除的反向依赖 | 主要验收 |
| --- | --- | --- | --- |
| P7 | 基线、目标规则与迁移清单 | 阻止新增越界，既有关系精确登记 | A04 |
| P8 | JSON、权限、Job、Terminal 契约 | host-config/jobs/terminal/sandbox → Protocol | A02/A03、B02/B03/B05 |
| P9 | 插件清单、资源与宿主数据契约 | plugins/mcp → Protocol | A02、B02/B03 |
| P10 | 产品领域记录、存储命令与通道桥接 | services/channels → Protocol | A01、B01/B04 |
| P11 | Node 与 Server 应用输入分离 | agent-runtime、Server application → Protocol | A01/A03、B03/B05 |
| P12 | Protocol 公开面与消费闭包 | 剩余混用出口、隐式声明和安装环 | A02/A04、B01/B06 |
| P13 | 权威文档、零例外与最终验收 | 全部本轮临时例外 | A01–A04、B01–B06 |

以下清单按最终实现更新。迁移编号 M31-M40 在 P7 用于登记旧关系；当前 `currentPhase = P13`、`stageExceptions = []`。P7 的 4,173 条快照保持历史含义。实现与最终验收已分别记录，具体命令、失败修正、验证范围和风险见[最终验收](../reviews/2026-10-22-protocol-layering-closeout.md)。

| 编号 | 唯一迁移主题 | 完成阶段 |
| --- | --- | --- |
| M31/M32/M33 | JSON 算法 / 权限数据和策略 / Job 与 Terminal 契约 | P8 |
| M34 | 插件、资源与 MCP 纯契约 | P9 |
| M35/M36/M37 | 产品领域记录 / Services 存储命令 / 通道应用桥接 | P10 |
| M38 | Node 宿主调用与 Server 应用接口 | P11 |
| M39/M40 | Protocol/Client/SDK 公开面 / 过渡出口与权威文档 | P12/P13 |

## P7：固定基线和约束

**位置：** 修改 scripts/architecture-policy.json、architecture-policy.schema.json、architecture-policy.mjs、architecture-boundaries.test.mjs；新增 docs/superpowers/reviews/2026-10-22-protocol-layering-baseline.md。沿用现有聚合入口，不建第二套导入解析器。

**接口：** 继续使用 `checkModuleDependency` 和 `collectArchitecturePolicyErrors`。阶段 schema 扩展为 P0–P13，迁移编号增加 M31–M40；新增精确来源、符号、目标路径、截止阶段的例外，不设全目录放行。

- [x] 记录 manifest 和实际导入两份清单，纳入 import type 表达式、测试、再导出及相对路径；保存当前字段、错误码、JSON fingerprint 和类型消费样本。
- [x] 增加“底层不能导入 Protocol”“Server application 不能借 DTO 调用通信 parser”“纯数据入口不能引入实现”的规则与反例。
- [x] 反例使用新来源文件，不能命中旧精确例外。例如以下断言在旧允许矩阵上应失败：

```ts
assert.ok(checkModuleDependency({
  fromFile: "packages/jobs/src/new-capability.ts",
  specifier: "@vykor/protocol", importedNames: ["JobSnapshot"], typeOnly: true,
}, policy).length > 0);
```

- [x] 将现存边按 M31–M40 精确登记，保持旧 P0–P6 例外为零；收紧规则不改变原生界面历史批准的文本与数量。
- [x] 运行架构反例、`pnpm check:architecture`、`pnpm check-docs`；最终反例由聚合入口统一执行，不再重复单跑；记录实际数量。
- [x] P7 基线随本次 P7–P13 整体提交。

**通过条件：** 基线能通过；新建来源、动态导入、隐藏 barrel/类型包装和越界子入口均被拒绝。循环依赖不属于可延期例外。

**P7 实际结果：** 9 份 manifest、273 个直接导入组、22 个类型样本、3 个类型消费者及固定 JSON/错误/权限样本已保存。当时的 4,173 条关系逐项绑定截止阶段；P0–P6 旧例外为 0。架构/兼容反例 60 项、Client 公开 API 4 项、Protocol 定向 38 项通过；文档和详细证据见 [P7 基线记录](../reviews/2026-10-22-protocol-layering-baseline.md)。这些数量不是 P8–P13 已完成的证明。

## P8：基础数据与能力契约（M31–M33）

**新建：** packages/json-data/package.json、src/json.ts、src/json.test.ts；packages/jobs/src/contracts.ts；packages/terminal/src/contracts.ts；packages/host-config/src/permission-modes.ts；packages/permissions/src/effective-permission-mode.ts。

**修改：** agent-contracts/src/permissions.ts、children.ts；host-config/src/permissions.ts；sandbox/src/approval-policy.ts；jobs/src/index.ts；terminal/src/provider.ts、events.ts；Protocol 对应文件及 Node 配置/审查调用方；相关 package.json、tsconfig、Vitest aliases 与锁文件。

**接口：** 保持现有 JSON 函数名称和输入语义；ApprovalMode/WorkMode 与执行审查数据沿用原字段；Job/Terminal 数据类型名称沿用现有名称，经 `/contracts` 导出。`TerminalWaitRequest.signal`、AgentJobHost、TerminalProvider 等活体接口不进入纯数据入口。

- [x] 写 JSON 字节与深度边界、非有限数、循环、普通/空原型、原型键、数字键排序的固定样本；使用基线确定性字符串，不用新旧两个实现互相证明。
- [x] 移动 JSON 算法并迁移真实消费者；不把 UUID 等无关工具扩入 json-data，不重写已有 MCP 结果边界。
- [x] 移动权限类型与模式函数，给配置归一化和权限计算分开归属；审批记录的数据类型留待 P10，不让 host-config 依赖 permissions 实现形成环。
- [x] 移动 Job/Terminal 数据，Protocol 显式引用规范来源；更新所有生产、测试和声明使用者，删除四个包对 Protocol 的 manifest 依赖。
- [x] 集中运行 json-data/jobs/terminal/permissions/host-config/sandbox 的相关测试和类型检查，以及 `pnpm --filter @vykor/terminal-node exec vitest run src/agent-terminal-host.test.ts src/local-terminal-provider.test.ts`、`pnpm check:architecture`。

**行为样例：** plan + full_access 仍为 plan；未知模式仍按原回退处理；终端等待/取消仍按 session owner 隔离；同输入的 canonical 字符串和 fingerprint 逐字节一致。M31-M33 旧例外已移除，按用户要求纳入本次整体提交。

## P9：插件与 MCP 契约（M34）

**新建：** packages/plugin-contracts/package.json、src/manifest.ts、presentation.ts、limits.ts、runtime.ts、runtime-data.ts、validation.ts、validation.test.ts；agent-runtime/src/node/plugin-apps/policy.ts 及测试。

**修改：** plugins/src/types.ts、manifest/schema-v1.ts、components/apps.ts、components/app-resources.ts、manifest/validate.ts；mcp/src/app-resources.ts；Protocol plugin-apps.ts、plugin-presentation.ts；agent-contracts/src/tool-data.ts；所有关联 exports、清单、锁文件与别名。

**接口：** plugin-contracts 使用方案第 5 节的 ValidationResult；清单类型字段不变。MCP 资源读取改为接收显式 `{ maxHtmlBytes, maxResourceBytes }` 上限，由 Node/应用组装传入当前值；MCP 不读取产品配置或页面数量。

- [x] 按方案第 4 节逐项拆分现有 PLUGIN_APP_LIMITS，记录直接消费者和边界测试；P10 创建的领域上限在此阶段先保持旧来源并登记精确例外，不能整对象更名转发。Node 默认值、格式硬上限、Server 会话打开配额必须分开。
- [x] 迁移作者清单、展示校验、后端/资源定义及不透明宿主数据；插件实现和 MCP 删除 Protocol 依赖。
- [x] Node 计算有效执行策略；Protocol 只携带描述。保留页面 policy 无效、granted 需要原授权证据、工具参数不能提高权限等现有拒绝行为。
- [x] 运行 plugin-contracts 新测试、plugins 的 components/apps.test.ts 与 components/app-resources.test.ts、mcp 的 app-resources.test.ts，以及 Node 新策略测试和受影响包类型检查。
- [x] 运行 `pnpm check:architecture`；确认纯声明不触达插件安装器/文件系统，M34 旧例外已移除；按用户要求纳入本次整体提交。

**通过条件：** 清单摘要、JSON 指纹、MIME、资源大小与拒绝结果不变；格式合法不能替代授权；Server 会话打开配额与 composer 输入数量检查继续生效。

## P10：领域记录和存储输入（M35–M37）

**新建：** packages/domain-contracts/package.json；src 下按方案列明的业务子目录建立 records.ts、validation.ts 和测试，含 usage/settings.ts、maintenance/records.ts、plugin-apps/limits.ts；services 的 sessions/conversations/runs/permissions/schedules/notes/session-runtime 等域 commands.ts；server/application/channel/durable-channel-bridge.ts；services/src/attachments/attachment-policy.ts、server/application/session/plugin-app-policy.ts。

**修改：** Protocol session.ts、session-model.ts、session-input-items.ts、session-requests.ts、session-goals.ts、attachment.ts、scheduled.ts、notes.ts、memory.ts、office.ts、runtime-config.ts、auto-review.ts、workspace-changes.ts、maintenance.ts 和 channel.ts；Services 对应 Repository/Transaction；channels/src/core/durable-bridge.ts 与其出口、Server 接线及测试。

**接口：** Domain 模块只暴露记录、数据输入和纯校验；插件输入返回 ValidationResult，既有领域 parser 使用 DomainValidationError 保留原拒绝语义。Services 的 commands.ts 独立定义 CreateSessionInput、AdmitPromptInput、CreateRunInput、AppendEventInput 等内部输入；名称可以沿用，但类型实体与 Server/Protocol 各自独立，不对 HTTP 类型直接做别名。逐项区分可选字段、默认处理与受信任字段。

- [x] 用既有输入样本冻结记录字段与不变量：Goal queuedResume/response/cancel_resume、附件引用、便签 expectedRevision、调度和通道幂等 ID 都须纳入。
- [x] 移动领域数据与纯校验；Protocol parser 保持原错误 code/field，调用规范校验并转换结果。读取历史 metadata 的纯函数留领域模块，配置修改和业务默认值迁入对应应用模块。
- [x] 领域包只接收用量价格/设置、存储保留配置和备份清单；报表/预览仍是查询结果，不能因应用层也使用就搬入领域包。拆分插件输入硬上限和 Server 会话配额，保留既有 4/8 数量边界。
- [x] 将 session-requests.ts 中写库/事务命令迁到 Services；记录类型可以复用，存储命令不能直接使用网络 Request。Services 移除所有 Protocol 源码与 manifest 依赖。
- [x] 将应用通道桥接迁到 Server，保留 channels 的传输/队列，迁移测试和所有调用方；不复制补发或输入 ID 算法。
- [x] 对 Services 和受影响 Server 应用包做类型检查，运行 Goal 排队、附件、便签、调度、通道的定向回归及 Protocol 对应 parser 测试；再运行 `pnpm check:architecture`，M35-M37 旧例外已移除；按用户要求纳入本次整体提交。

**通过条件：** schema 和线格式无变化；新增非 HTTP 调用仍执行输入不变量；存储层不能导入 ProtocolValidationError、请求 parser 或任何宿主辅助实现。

## P11：Node 与 Server 用例接口（M38）

**实现位置：** Server application 的 session/inputs.ts、session/plugin-app-inputs.ts、schedule/inputs.ts，以及所属服务的窄输入；maintenance/query-models.ts、observability/query-models.ts、channel/query-models.ts、session/query-models.ts；http/mappers/session.ts、plugin-apps.ts、maintenance.ts、execution-observability.ts；session/plugin-app-host-binding.ts 与应用授权回归。纯记录按规范类型复用，不为没有 producer 的 OfficePreview 创建空查询模型或 mapper。

**修改：** agent-runtime/src/node/runtime/agent.ts、agent-options.ts、default-runtime.ts、agent-composition.ts；node/review/approval-reviewer.ts；node/plugin-apps/ 下的 runtime/backends；Server 的 Goal、配置、应用工具服务、HTTP 调用方和 Services 命令调用方。

**接口：** 采用方案第 6 节的 PluginAppHostInvocation 与 PluginAppHostBinding；`AgentHost.plugins.runPluginAppTool(invocation, options)` 不再接收 PluginAppRecord 或 PluginAppToolRequest。绑定保留不透明 `instanceId = app.id` 做隔离与撤销，不携带可变产品记录；Node 保留原 lease 权威，Server 不增第二份 token 表。Node 输出 PluginAppToolOrigin，Server 将 requestId、revision、应用动作关联到可靠事件。

- [x] 增加 Server 输入映射和 Node 二次绑定校验的失败回归：跨 owner、伪造 digest、过期 generation/lease、已撤销插件、页面附带授权字段均拒绝。
- [x] 将请求解析、应用记录/revision 校验和管理用例输入移入 Server 对应层；Node 接收已生成的绑定，保留自己的当前来源和工具身份检查。
- [x] 将维护报表、运行观察和通道状态拆成应用查询模型与 Protocol DTO；HTTP 负责转换，不使用 Protocol 类型别名伪装独立输入。Services Office 转换保留自身 OfficeDocumentPreview，OfficePreview 无 Server producer，不造空 mapper。事件服务输出领域 SessionEventRecord，SSE 包装和序列化只由 HTTP 层执行。
- [x] 迁移配置与审查调用方，清除 Node 和 Server application 的 Protocol 导入；防止改为依赖 domain-contracts 后仍把整份应用记录交给 Node。
- [x] 运行现有应用授权、来源投影、approval-reviewer 和 native-plugin-app-backend 定向测试，以及 `workflow-host.child-cancellation.test.ts` 的四种取消回归；统一运行 Runtime/Server 类型检查和架构门禁。
- [x] 确认普通工具与应用工具仍共用 Kernel.runTool，关闭/借用责任没有新增分支；M38 旧例外已移除；按用户要求纳入本次整体提交。

**通过条件：** Node 的 API 和声明不出现产品持久记录、HTTP Request、Goal 或 Repository；Server application 无 Protocol 依赖，核心执行仍只消费捕获绑定。

## P12：通信公开面与 SDK（M39）

**修改：** protocol/src/index.ts、requests.ts、serialization.ts 和剩余 DTO 模块；client 的声明/公共 API 与浏览器消费测试；Runtime scripts/build.mjs、kernel-boundary.mjs、verify-pack.mjs 的闭包验证；三新包和 jobs/terminal 的 exports、清单、锁文件与声明别名。

- [x] 移除旧存储命令和策略出口；Client 旧 PLUGIN_APP_LIMITS 聚合导出拆为 DATA/INPUT/RESOURCE 三个硬上限出口，公开清单随之迁移；对合法通信数据使用明确的 type 再导出，避免 export * 扩散能力接口。
- [x] 明确请求/记录/视图映射，保证版本 5 和现有 wire fixture 不变；解码拒绝函数、Promise、AbortSignal、非有限数和非法嵌套数据。
- [x] Client 仍仅直接依赖 Protocol；已有配置、模式和插件策略 helper 由 Client 本地请求构造/显示投影实现，不作为宿主授权。扩展当前声明来源规则时，按规范子路径限定来源；不能将任意 domain/plugin/job/terminal 根导出整体放行。
- [x] 运行 `pnpm check:client-api`、Protocol parser/serialization 定向测试、`pnpm test:client-browser`，再集中运行一次 `pnpm --filter @vykor/agent-runtime test:pack`。
- [x] 补齐包级无环、独立 tarball 安装和声明闭包门禁；Kernel 维持原允许上限，明确拒绝 domain-contracts/plugin-contracts/json-data。M39 旧例外已移除。独立消费的最终结果统一记入 P13，按用户要求纳入本次整体提交。

**通过条件：** 浏览器输出与 Kernel 声明中无 Node 宿主/存储/产品领域记录；默认 SDK 仍可运行原生工具、PTY、root/child 和幂等关闭。

## P13：最终验收与权威文档（M40）

**修改：** docs/architecture-overview.md、protocol-contract.md、agent-sdk.md、agent-framework-capability-boundary.md、daemon-application-architecture.md、session-runtime-storage-architecture.md、jobs-protocol.md、contract-test-index.md、docs/README.md 和本计划；新增 docs/superpowers/reviews/2026-10-22-protocol-layering-closeout.md。

- [x] 对照方案 A01–A04/B01–B06，每条关联一个具体测试或静态检查及最近有效结果；记录未执行的平台，不把旧全量测试当作新代码验收。
- [x] 删除 M40 及所有本轮过渡例外，去掉没有真实消费者的依赖、内部旧出口和源码转发文件；Protocol 合法通信再导出保留明确白名单。
- [x] 集中运行 `pnpm check:architecture`、`pnpm check-docs`、受影响包类型检查，以及之前未覆盖或最后修改影响到的定向回归；P12 后 SDK/浏览器输入未变则复用证据。
- [x] 更新权威文档与架构图，标明新职责、数据转换点和沿用的资源关闭负责人；源码和文档事实不一致时以实际代码补齐，不能只勾选清单。
- [x] 已补录最终验证命令/退出码、精确例外清零、错误/字段一致性及回退范围，见[最终验收](../reviews/2026-10-22-protocol-layering-closeout.md)。P7–P13 合为本次整体提交。完整 `pnpm test` 仅在仍有不能定向覆盖的跨域风险时运行，并先说明必要性。

**通过条件：** 九个底层包及 Server application 的 Protocol 依赖清零，stageExceptions 为空；公开线格式、数据和执行语义守住基线；所有验收条目都有有效证据。

## 最终集中验收结果

全部方案标准 A01–A04/B01–B06 已关联具体证据，详见[最终验收记录](../reviews/2026-10-22-protocol-layering-closeout.md)。本轮没有运行完整 `pnpm test`；只在失败修正后补跑受影响范围，最后统一检查架构与文档。

| 范围 | 结果 |
| --- | --- |
| A01–A04：依赖、纯入口、执行数据与 AST 门禁 | `pnpm check:architecture` 退出 0；53 项架构反例、9 项兼容检查、4 项 Client 公开 API；workspace 无环，9 个底层包和 Server 非 HTTP 无 Protocol 越界；阶段例外 0 |
| B01–B03：通信、JSON、权限与插件授权 | Protocol 123、HTTP mapper/路由 56、绑定及错误转换新增 5、授权和来源投影 30 项通过；基础/Node/Client 定向证据分别记录，不重复累计 |
| B04–B05：领域状态与取消收尾 | Domain/Services 117、Server 核心 193、迁移补验 8、Terminal 21、Workflow 取消 4、Sandbox 3、历史重启 2、联合 HTTP 筛选 5 项通过 |
| B06：Client 浏览器与独立 SDK | 两项构建/独立消费均退出 0；Windows ConPTY 辅助进程仍有既有错误输出，功能探针全部通过；Linux/macOS 未执行 |
| 类型与文档 | 工作区 73 个任务、最后 Server tsc 及联合类型检查通过；文档 471 个 Markdown 文件有效；差异检查通过 |
| 当前策略 | P13，stageExceptions 为空；4,173 仅为 P7 历史快照；历史精确批准 729 条、移除路径 90 个 |
| 提交、发布与用户数据 | P7–P13 合为本次整体提交；未推送、未发布，未重置真实用户数据 |

## 当前进度

- [x] 完成现状核对、类型/校验/策略归属和分阶段计划。
- [x] P7 基线与门禁（2026-10-22；代码及验收完成，随本次整体提交）。
- [x] P8 基础数据与能力契约实现。
- [x] P9 插件与 MCP 契约实现。
- [x] P10 领域与存储接口实现。
- [x] P11 Node 与应用接口实现。
- [x] P12 通信公开面与 SDK 边界实现。
- [x] P13 权威文档与零例外调整。
- [x] P13 最终集中验收结果与平台范围补录。
- [x] 按用户要求整体提交 P7–P13，包含回归、检查和验收文档；临时核对脚本与日志不入库。

P8-P13 已获连续授权，无需逐阶段确认。P7 记录保留迁移前事实，本计划与最终集中验收记录描述迁移后的实现；本轮失败修正和平台验证范围均在最终记录中列明。本次提交已获明确授权；推送与发布仍未执行。

## 最终复查后修复（2026-10-22）

- [x] 补上 P2 级架构门禁缺口：沿选中声明及其私有别名检查运行类型引用；Protocol 的 Jobs/Terminal 直接导入和包装来源限定为 `/contracts`。同文件中的纯数据有正例保护，不整文件封禁 permissions。
- [x] 插件 HTTP 使用明确错误类型或错误码分类；Protocol parser 转换校验结果，Node 与静态资源入口提供结构化错误，保持应用错误、未接纳响应及未知运行错误的处理。
- [x] 新增门禁、parser、HTTP 和错误产生处的正式回归，确认旧实现失败后再修复；补验真实 Native 和静态资源游标错误。
- [x] 完成集中验证并补录[验收记录](../reviews/2026-10-22-protocol-layering-closeout.md)；只执行相关回归、受影响包类型检查及架构/文档门禁，不重复全量测试。用户随后授权提交全部当前改动、合入 main 后推送，最终结果以 Git 记录为准。
