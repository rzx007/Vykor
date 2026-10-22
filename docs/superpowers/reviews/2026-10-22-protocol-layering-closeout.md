# Protocol 分层最终验收（P7–P13）

> 状态：当前实施验收记录。2026-10-22；Windows / Node.js 24.18.1 / pnpm 10.30.2。实现、定向回归、类型、架构、文档及独立消费验收完成。

对应[方案](../specs/2026-10-22-protocol-layering-design.md)和[实施计划](../plans/2026-10-22-protocol-layering.md)。用户已连续授权后续阶段；本轮只运行相关回归和检查，没有运行完整 `pnpm test`。按用户要求将 P7–P13 代码、正式回归、架构检查、文档和验收记录合为本次提交；未推送或发布。

## 最终复查后修复（2026-10-22）

原 P7–P13 提交为 `3d7945e3`；以下是随后复查发现的问题及本轮修复证据，后文数字保留原阶段事实。本轮开始时工作区干净；修复期间并行新增的插件市场计划文档未改动、不计入修复范围。用户随后授权提交全部当前改动、合入 main 后推送，插件市场计划文档一并纳入提交。

- **P2 级门禁缺口：** 原扫描只检查消费文件中的运行类型名，没把来源声明中的 Promise/AbortSignal 带回规则检查，私有别名也会丢失来源。现在按选中声明收集引用并沿别名传播；加入 Protocol 的 Job/Terminal `/contracts` 入口约束，直接导入、相对路径和本地再导出均受检查。回归同时确认 permissions 同文件中的 ApprovalMode 等纯数据仍合法。没有增加阶段例外或扩大白名单。
- **插件 HTTP 错误适配：** 移除错误 message 前缀判断。Protocol parser 将 ValidationResult 转为 ProtocolValidationError；plugin-contracts `/runtime-data` 定义纯结构化校验错误和精确 code 识别。Node 参数/策略/Native 游标及 Server 静态资源游标提供 code，跨 Runtime bundle 不依赖同一份 class。未知错误保持 409 和通用响应，ApplicationError 及未接纳响应仍走既有分支。畸形 JSON、数组动作请求由误报 409 修正为 400，通用响应体不变。
- **回归有效性：** 修复前，2 项新架构反例、1 项 parser、8 项 HTTP 分类及 2 项错误产生处断言失败，确认命中原问题；修复后执行定向回归。保留日常测试入口，没有新增临时脚本或一次性测试文件。

| 本轮验证范围 | 结果 |
| --- | --- |
| Protocol 插件 parser / 通信基线，两文件 | 10 项通过 |
| Runtime 策略 / Native 后端 / 原始应用工具执行，三文件 | 30 项通过；随后新增非对象参数拒绝回归，单独筛选 1 项通过、18 项跳过，未重复执行旧组 |
| Server 错误 / decoder / mapper / 真实插件 HTTP / 应用服务，五文件 | 43 项通过 |
| 新增 Native 运行与静态资源游标 HTTP 断言 | 2 项通过、4 项跳过；仅补跑这两项，证明真实 Runtime 错误跨包适配和离线分支均返回 400 |
| plugin-contracts / Protocol / Runtime / Server 类型检查 | 均退出 0 |
| Runtime 构建 | 退出 0，三个 bundle 构建完成 |
| `pnpm check:architecture` | 退出 0；55 项架构反例、9 项兼容检查、4 项 Client API；源码/声明与 workspace 无环扫描通过，阶段例外 0、flat-call 基线 104；clean-slate 通过，历史精确批准仍为 729 条、已移除路径 90 个 |
| `pnpm check-docs` 与差异检查 | 文档检查退出 0；472 个 Markdown 文件（含并行计划文档），链接、章节、源码路径、状态及契约映射有效；差异无空白错误 |

未运行完整 `pnpm test`，也未重复独立 SDK pack 或浏览器构建；本轮只重建受影响 Runtime 并验证真实 HTTP 消费。验证平台仍为 Windows。

### 合入 main 前补验

全部当前改动（含插件市场计划）已保存为 `44816b29`，提交钩子的 73 项工作区任务及 Server/Client 联合类型检查通过。合并远端 `cd59af3e` 时，12 处冲突按当前规范所有者和迁移位置处理；核心内容与该提交一致，保留远端新增的 11 个桌面文件。

桌面更新器、外观和工具面板三文件 49 项通过，文档与桌面依赖边界检查通过。额外桌面类型检查发现两个测试夹具遗漏：StreamEvent 仍从 Core 导入、HookExecutor 替身仍提供旧 register；已改从 agent-contracts 导入并只保留 execute。仅补跑这两个文件，20 项通过，没有重跑核心或单仓全量测试。

桌面 Web 严格检查另外发现五个私有 Symbol 标记读取未被识别、五个迁移后未使用导入；已明确读取所属错误类的私有标记并移除多余导入，未公开标记或更改 Symbol 值。执行限制错误的 helper 复用相同 instanceof 判定；7 项本地及跨 bundle 错误身份回归通过，agent-contracts / Protocol 的 `tsc --noEmit --noUnusedLocals` 退出 0。Electron SDK 夹具改用 Client 已公开的 MCP parser，移除已删除源码路径。

等待期间新增的 Transcript 运行指示修复按“提交所有代码”要求一并纳入，其单文件 16 项通过。桌面 Node / Web / MCP Apps SDK 三项类型检查分别通过；Web 与 SDK 只在修正各自失败后补跑对应命令，没有重复已通过的测试组。

### main 推送后的 CI 修复

`e9f64590` 的 [CI 39778381610](https://github.com/rzx007/Vykor/actions/runs/39778381610) 在 Build 阶段失败：桌面测试的 `@vykor/agent-contracts` 类型导入违反桌面仅直接消费 Client/Server 的入口规则。该导入是合并前修正旧类型导入时引入的；此前边界检查在这一修改之前运行，不能证明最终提交通过。后续 Type check、架构、文档和 Test 步骤被跳过，不记为通过。

本次移除该导入及显式返回类型，用事件字面量推断保留测试的类型检查；不扩大白名单、不恢复旧公开导出，也不改用源码相对路径绕过检查。原边界命令先复现退出 1，修复后退出 0；`tool-summary-files.test.ts` 单文件 1 项通过，CLI 构建输出 4 个文件、退出 0。只运行相关验证，没有执行完整 `pnpm test`。

随后运行 Desktop 构建，三项类型检查通过，但资源复制暴露出另一处迁移遗漏：仍读取 `agent-runtime/src/native-tools/host-entry.mjs`。已将正式构建和 Plugin Apps 测试后端脚本统一指向 `src/node/plugins/native-tools/host-entry.mjs`；后端构建脚本退出 0。只重跑受影响的 Electron 打包阶段，不重复已通过的类型检查或测试。

最终 `pnpm --filter @vykor/desktop exec electron-vite build` 退出 0，文档预览、Main、Preload、Renderer 均完成。`verify-update-packaging.mjs --build` 退出 0，正式产物与测试后端的两份 Host 文件均逐字节匹配规范源码。以上为本机 Windows 定向验证；远端原 CI 的后续步骤未执行，修复推送后的 Linux CI 结果需另行确认。

## 实际收敛结果

| 阶段 | 完成内容 |
| --- | --- |
| P7 | 保存迁移前 9 份 manifest、273 个直接导入组、22 个类型样本及行为基线；4,173 个精确阶段例外只保留在历史快照 |
| P8 | JSON 算法归 json-data/json；执行权限数据归 agent-contracts/permissions；模式归一化归 host-config，有效权限计算归 permissions；Job/Terminal 数据归各自 /contracts |
| P9 | 插件清单、展示、资源校验、硬上限和不透明宿主数据归 plugin-contracts 明确子入口；安装器、MCP 连接和 Node 策略留在实现包 |
| P10 | 产品记录及数据不变量归 domain-contracts 各业务子入口；存储命令归 Services；持久通道桥接迁至 Server application/channel |
| P11 | Server 使用独立用例输入和查询模型；HTTP mapper 转换通信数据；Node 接收可信 binding 和 invocation，保留二次来源检查与原 lease 权威 |
| P12 | 移除 Protocol 内部策略与存储出口，保留通信使用的规范数据；Client 只直接依赖 Protocol；Kernel bundle 与声明上限保持原范围 |
| P13 | 当前阶段 P13、stageExceptions 为空；同步权威文档、交互架构图和验收映射，历史批准逐行校正 |

对 9 个底层包的源码（含测试）和 manifest 重新统计：Protocol 直接引用均为 **0**。packages 中声明 Protocol 运行依赖的包只剩 **client、server**。Server 非 HTTP 目录也受源码和声明来源检查，不能用本地包装或类型别名绕回 Protocol。Services 可以经 Domain 引用插件的纯数据声明，不能直接依赖插件契约包或使用后端 lease。

新纯包不提供包根汇总入口；按 `/json`、`/manifest`、`/runtime-data`、`/sessions`、`/goals` 等明确入口消费。agent-contracts 没有吸收 Session、Goal、附件、便签、插件清单或通用 JSON 实现。

## 与原计划的具体调整

- `PluginAppHostBinding` 保留 `instanceId = app.id`，作为 Node 隔离实例与撤销 lease 的不透明键。Server 从可信记录挑选身份，状态、revision、Run 账本不进入绑定；页面字段不能覆盖它。Server 没有增加第二份 token 表。
- `DEFAULT_ATTACHMENT_LIMITS` 单一归属 Services 的 `attachments/attachment-policy.ts`。独立 Services 构造器原本就需要默认策略，Server 复用它；Domain 只定义限制形状和校验。
- Services Office 转换输出自身 `OfficeDocumentPreview`。目前 Server 没有 OfficePreview producer，因此保留 Protocol 通信类型，未新增空查询模型或端点。
- Client 保留本地配置、模式和工具描述辅助函数，用于显示和构造请求。Server 与 Node 仍独立决定授权和有效策略。
- 插件输入采用 ValidationResult；既有领域 parser 保留抛错流程，改抛纯 DomainValidationError，由 Protocol/HTTP 转换成原通信错误。Services commands.ts 沿用内部 Input 名称，但类型定义独立于通信和应用输入；未为更名批量改写存储调用。
- 源码导出名有有意调整：混合 `PLUGIN_APP_LIMITS` 移除，Client 改用 `PLUGIN_APP_DATA_LIMITS`、`PLUGIN_APP_INPUT_LIMITS`、`PLUGIN_APP_RESOURCE_LIMITS`。Protocol 中配置策略和存储命令的原导出移往规范所有者；不能据此宣称所有源码导出兼容。通信版本仍为 5。

## 方案验收对应

| 标准 | 本轮证据 |
| --- | --- |
| A01 底层与应用层无 Protocol 依赖 | 9 包重新统计均为 0；最终源码/声明/manifest 扫描与阶段例外检查 |
| A02 纯数据入口、无环 | 架构反例拒绝 I/O、实现绕行、AbortSignal/Promise/Repository 等活体类型；workspace 图与 Kernel 打包检查 |
| A03 执行契约不承接所有公共类型 | 三个独立纯包和 Job/Terminal 子入口；agent-contracts 只增加执行权限数据和 MCP MIME 常量 |
| A04 绕行也受约束 | AST 反例覆盖动态导入、再导出、别名、相对路径、函数签名、循环类型包装和声明来源；新增 Server 非 HTTP 与存储插件数据来源反例 |
| B01 通信与持久格式 | Protocol 123 项、HTTP mapper/路由 56 项、联合 HTTP 5 项；未修改协议版本、数据库 schema 或事件游标算法 |
| B02 JSON 与指纹 | JSON 固定字节/哈希、20/32 层、原型键、非有限数及大小边界回归；未用两个新实现互相证明 |
| B03 权限和来源 | 权限与配置 91 项、Node 审查 59 项、插件契约/Node 89 项；Server 应用动作回归及新增绑定/错误转换 5 项 |
| B04 领域状态与可靠记录 | Domain/Services 117 项；Server Goal/排队/恢复、配置、观察、通道等核心回归 193 项；迁移测试补跑 8 项；历史重启 2 项确认原记录保留且执行调用为零 |
| B05 Job/Terminal 与取消 | Jobs 27 项、Terminal 21 项、四种 WorkflowHost 取消 4 项；资源所有者、根树复用及等待清理流程保持原职责 |
| B06 浏览器与独立 SDK | Client 浏览器构建；独立 tarball 的声明、Native Tool、默认 PTY/Job、root/child、事件与幂等 close 均通过 |

以上各组存在覆盖重叠，不累计成独立测试总数。实现审查未发现高、中风险遗留问题；跨平台范围见后文。

## 集中验证记录

| 命令或范围 | 结果 |
| --- | --- |
| json-data / host-config / permissions / jobs 定向 | 133 项通过；相关基础包类型检查通过 |
| plugin-contracts / plugins / mcp / Node 插件定向 | 89 项通过；相关包类型检查通过 |
| Domain / Services 定向 | Domain 3 项、Services 六文件 114 项，合计 117 项通过；类型检查通过 |
| Client 配置/策略/commands 定向 | 48 项通过 |
| Node review / default-runtime 定向 | 59 项通过 |
| Server 核心 15 文件首次集中执行 | 14 文件 193 项通过；1 个迁移测试未加载，原因是旧 Feishu 相对路径 |
| 修正迁移路径后，通道及 HTTP 组装/重启 3 文件 | 8 项通过；未重复执行上述 193 项 |
| HTTP mapper、协议拒绝、路由与真实插件请求 | 4 文件 56 项通过 |
| Server 运行授权及 transcript 来源投影 | 2 文件 30 项通过 |
| 新增 Server binding / Domain 错误转换 | 2 文件 5 项通过；用测试名筛选，没有重复执行旧测试 |
| Protocol parser / serialization / 基线等 12 文件 | 123 项通过 |
| Terminal 两文件 / Workflow 取消单文件 | 21 / 4 项通过 |
| Sandbox 审批策略单文件 | 3 项通过 |
| 历史重启与退役禁入单文件 | 2 项通过，原始指纹与结果保留，模型/工具执行为零 |
| Client/Server 联合 HTTP 筛选 | 5 项通过；其余 61 项跳过，未重复全套 |
| `pnpm check-types` | 73 个工作区任务全部通过；附加联合类型检查首次发现旧默认策略导入，修正后独立 `pnpm check-types:server-client` 退出 0 |
| Server 非 HTTP 测试最后 7 处类型导入迁移 | 最后一次 Server `tsc --noEmit` 退出 0；仅导入变化，未重复运行测试 |
| `pnpm test:client-browser` | 退出 0，103 个模块构建完成 |
| `pnpm --filter @vykor/agent-runtime test:pack` | 退出 0，独立安装和所有运行探针通过 |
| Kernel 边界脚本 | 8 项通过，包括新数据包及 Windows 相对声明路径反例 |
| Client 公开 API | 旧 limits 清单同步后 4 项通过；最终门禁再次核对 |
| `pnpm check:architecture` | 退出 0；53 架构反例 + 9 兼容检查 + 4 Client API；源码/声明与 workspace 无环扫描通过，阶段例外 0，既有 flat-call 基线 104 未增加 |
| 聚合门禁中的 clean-slate / 历史检查 | 均退出 0；工具回归 1 项，729 条精确批准、90 个已删除路径检查通过 |
| `pnpm check-docs` | 退出 0；471 个 Markdown 文件，链接、章节、源码路径、状态和契约测试映射有效 |
| 差异与新增文件空白检查 | 通过；未混入无关代码修改 |

首次门禁失败只重跑受影响范围；最后架构门禁会重新检查其固定的公开 API 与反例。没有重跑完整 `pnpm test`，也没有为文档调整重复构建 SDK 或浏览器。

## 历史引用及回退范围

历史批准从 719 调整为 729：67 行迁移或新增适配引用，57 行原位置引用删除或迁出；未变引用保留原理由，只校正精确行号。新增位置逐行复核为历史数据读取、保留字段防伪、通信错误适配或检查器自身；没有增加目录豁免。历史纯解析改从 Domain 的 `/plugin-apps/history` 消费，依赖白名单继续拒绝执行或加载实现。P7 依赖快照只作为明确指定的检查输入隔离，不能授权新运行入口。

本次将连续迁移合为一个提交。回退必须整体恢复相关类型所有者、调用方、exports、manifest、锁文件、门禁和文档，不能只恢复一条旧再导出，否则会重新形成反向依赖。真实用户数据库、凭据及配置未做迁移或重置。

## 验证范围与剩余风险

- 本轮在 Windows 验证，未声称 Linux/macOS 平台执行结果，也未执行完整单仓测试套件。
- SDK pack 中 Windows ConPTY 辅助子进程仍会输出 `AttachConsole failed`；主探针、TerminalOpen/JobCancel 及最终退出码均成功。这是已有环境现象，本轮未扩大为终端实现修复。
- 外部源码消费者需要同步旧策略、存储命令和混合 limits 的导入位置；HTTP/SSE 格式与已验证行为保持基线。
- 以后新增字段仍需分别维护应用模型与通信投影，并补对应 mapper 用例；结构相同不意味着可以把 HTTP Request 重新用作存储命令。

## 提交与临时文件

本次新增测试均为日常 Vitest、架构门禁或契约回归，保留其正式入口。一次性核对、批量迁移脚本和运行日志位于本次被忽略的工作目录，不进入提交；完成提交核验后清理该目录。提交前复用上述定向验收，执行仓库 pre-commit 类型检查、文档与差异检查，不重复完整测试套件。
