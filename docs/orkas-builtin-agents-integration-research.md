# Orkas 内置智能体调研与 OpenHarness 集成建议

> 状态：当前调研资料；研究与写作插件已完成第一版代码接入，其余集成建议尚未实施。

调研日期：2026-10-11。对象是本机源码，Orkas 提交 `eb5dde92cf397db57831d34a23823bc0b458d1bb`，OpenHarness 提交 `feb050a3992096e9f73b4a6dece2a59c8ad9aaf4`，并查看当前工作区。本文记录代码事实和集成建议，没有启动 Orkas、调用模型、验证媒体成品或修改应用代码。优先级与工作量是工程判断，尚未通过原型验证。

## 1. 结论

最值得集成的是 **DeepResearcher、ContentWriter、PptMaker 和 OfficeWorker**。前两项可以先形成低成本的研究写作能力；后两项能让应用从回答问题进一步走到交付可编辑文件，但需要完整的办公文件读取、生成、修改和检查工具。

UIDesigner、ImageStudio 也有价值，建议先接入固定产物目录、持续修改和 HTML/SVG 排版能力，后续再补图片生成和导出。ProductDeveloper 与我们现有开发能力高度重叠，适合吸收完成标准。VideoStudio、VoiceStudio 依赖较重，后续专项推进。SEO、电商与股票智能体适合作为按需安装的专业扩展。

**真正值得借鉴的是“专业任务说明 + 可执行工具 + 产物检查 + 后续修改”这条完整流程。** 只添加角色名称和提示词，不能复现 Orkas 的使用体验。

建议先落地一个“知识工作”能力包：用户选择它后，输入研究问题或已有资料，得到带来源的报告，随后直接说“改成文章”或“补充这一部分”，应用继续处理同一份成果。第二阶段再让同一条流程交付 Word、Excel、PPT。

## 2. 本地实际内置了什么

README 宣称 9 个内置专家；资源清单与安装代码表明，本地版本包含 **16 个智能体、22 个共享技能、55 个智能体私有技能目录、4 个系统技能**。私有技能数量按目录记录相加，不代表 55 种互不重叠的能力。

对清单中的全部智能体检查了 `skill_list`：每个依赖都能在共享技能 ID／名称或该智能体私有技能清单中找到。这个检查证明资源声明完整，不证明脚本或宿主工具运行成功。

启动同步会遍历打包的智能体和技能目录，发布到当前用户空间；已被用户删除的条目通过删除记录跳过。内置内容更新走安装锁和目录替换。离线拥有资源，也不意味着联网研究、图片或语音服务离线可用。

证据：[资源清单](D:/code/personal-project/Orkas/resources/builtin/_manifest.json)、[安装与更新逻辑（第 680 行）](D:/code/personal-project/Orkas/src/main/features/builtin_marketplace.ts)、[启动同步](D:/code/personal-project/Orkas/src/main/features/bundled_content_startup.ts)。

| 智能体 | 实际工作与用户收益 | 建议与相对工作量 |
|---|---|---|
| DeepResearcher | 多来源研究、引用核对、矛盾证据与缺口记录；报告更容易复核和继续补充 | 第一批；中。需改写脚本运行入口和检查机制 |
| ContentWriter | 完整成稿、改写、语气调整、渠道适配、事实审校；减少反复补写与无依据扩写 | 第一批；小到中。先支持文本和 Markdown |
| PptMaker | 创建、编辑、审查原生可编辑 PPTX；用户获得能继续修改的演示稿 | 第二批；大。与 Office 共用引擎 |
| OfficeWorker | Word、Excel、普通 PPT、PDF 的处理与批量交付；减少文件转换和手工整理 | 第二批；大。先缩小格式和保留能力承诺 |
| UIDesigner | HTML 设计稿、界面流程、现有 UI 参考重建、持续修改 | 第一批可吸收产物管理，第二批形成完整能力；中 |
| ImageStudio | HTML/CSS/SVG 排版，必要时生成图片；文字、品牌素材和布局可保持确定性 | 第二批；排版中，完整生成与导出大 |
| ProductDeveloper | 需求、调试、重构、代码评审与验证；把验收条件逐项对应到证据 | 吸收方法；小到中。已有 worker／review／verification |
| SeoGeoAgent | 网站搜索优化与被 AI 引用的准备度诊断，行动清单、复测和监控 | 专业扩展；中到大。需适配网络与脚本入口 |
| VoiceStudio | 配音、转写、字幕、音频剪辑与混音；按片段继续修改和恢复 | 后续专项；大。TTS、FFmpeg、Whisper 与模型分发 |
| VideoStudio | 生成素材、HTML 动画、素材剪辑、字幕配音、装配与质量检查 | 后续专项；很大。不能靠一个视频提示词实现 |
| ECommerceResearcher | 按预算、市场、竞品和利润条件选择商品，给出下一步验证 | 电商扩展；中。数据可得性决定效果 |
| ECommerceReviewer | 从评论与客服反馈提炼主题、痛点和改进优先级 | 电商扩展；中。可先支持用户提供的数据 |
| ECommerceWriter | 商品标题、卖点、详情页、FAQ 与创意脚本 | 电商扩展；小到中。复用写作底座 |
| ECommerceAnalyzer | 销售、利润、广告、退款与库存分析，保留计算口径 | 电商扩展；中。需要真实计算与字段映射 |
| ECommerceOperator | 准备并执行店铺变更，逐项记录执行与核对结果 | 后置；大。受真实连接器能力约束 |
| StockAnalyser | 行情、研究、回测、组合风险与订单草稿，要求数据来源和交易校验 | 低优先级专业扩展；大。当前主体验收益有限 |

全部角色定义见 [智能体资源目录](D:/code/personal-project/Orkas/resources/builtin/marketplace/agents)。额外值得吸收的共享技能是 `material-organizer`（把杂乱资料整理成可追溯笔记）与 `data-analysis`（实际计算、保留单位和统计方法），它们不是独立的内置智能体。

## 3. Orkas 的完整运行流程

入口是一个主对话。Commander（负责选人和组织工作的主智能体）读取当前可用专家的简短目录，根据交付物选择直接处理、交给一个专家，或调度多个专家后汇总。

- 简单、当轮能做好的一项工作直接完成，减少额外模型会话。
- 一个专家负责剩余成品时，调用 `hand_off_to`，由专家直接交付。
- 主智能体还需要使用专家结果时，调用 `dispatch_to`；独立结果可以并行，存在依赖的步骤逐个推进。
- 名称前的 `@` 用于界面展示，真正调度依靠工具调用。

专家有自己的 `agent.json`：任务描述、工作步骤、质量标准、输入定义、工具组、技能依赖和界面元数据。运行时根据当前专家 ID 注入它能读取的技能，私有技能通过 `ownerAgent` 限定归属。脚本统一经过 `bin/run-skill.cjs` 定位并运行，不只是读一段 Markdown。

状态分为对话与调度记录、专家记忆／学习技能，以及工作区中的产物文件。专家在对话返回文本与实际输出路径；交互 HTML 由独立协议和受限 iframe 展示，可以把用户操作送回创建它的专家。

当前 `plan_executor.ts` 的注释明确说明：旧的静态任务依赖图执行器已被主智能体逐步调度替代。不能根据文件名误认为 Orkas 仍主要依靠预先固定的任务图。

证据：[主智能体说明](D:/code/personal-project/Orkas/src/main/prompts/chat_commander.md)、[调度运行](D:/code/personal-project/Orkas/src/main/features/group_chat/bus.ts)、[结束状态处理](D:/code/personal-project/Orkas/src/main/features/group_chat/plan_executor.ts)、[技能归属与工具注入（第 560 行）](D:/code/personal-project/Orkas/src/main/model/core-agent/runner.ts)、[脚本入口](D:/code/personal-project/Orkas/bin/run-skill.cjs)、[交互产物](D:/code/personal-project/Orkas/src/renderer/modules/chat-artifact.js)。

## 4. 优先集成的能力

### 4.1 深度研究：让结论有依据，也能补做

DeepResearcher 的关键资产是 `deep-research` 技能及四个 Python 脚本：`caps` 记录检索预算，`academic` 搜索学术来源，`compress` 压缩证据，`citations` 检查来源、原句与引用绑定。脚本使用标准库；学术脚本声明了多个固定 API 来源，但本次没有验证这些远端 API 的当前可用性。

值得保留的规则是：搜索摘要只用于发现来源；每项结论和比较表格单元格都对应自己的证据；失败来源和矛盾证据留下记录；资料不足时返回有条件的结论。引用脚本明确不能判断“证据语义上是否足以支持结论”，仍需要模型逐项核对。

我们已有 WebSearch、WebFetch、文件工具和子会话。第一版用网页、Markdown／文本资料形成报告即可；将证据和未完成问题保存下来，让“继续补充价格信息”只补缺口。可复用脚本算法，但应改成 OpenHarness 的工具接口或受控脚本入口，替换所有 `ORKAS_*` 环境变量与平台路径。

验收示例：比较三个项目时，每项关键差异都能定位到实际读取过的来源；中断后继续不会无理由重抓全部资料；来源失败会出现在报告限制中。

证据：[专家定义](D:/code/personal-project/Orkas/resources/builtin/marketplace/agents/78900d8758bc/agent.json)、[研究技能](D:/code/personal-project/Orkas/resources/builtin/marketplace/skills/ee99fbb42964/SKILL.md)、[脚本目录](D:/code/personal-project/Orkas/resources/builtin/marketplace/skills/ee99fbb42964/scripts)。

### 4.2 内容写作：直接交付完整稿件，修改时保留原意

ContentWriter 支持规划、研究、成稿、修改、自然化、审校和适配。它根据任务选择最少步骤，普通短文直接成稿。改写时保留来源中的事实、限制条件、引用和确定程度，避免把“可能”写成“必然”。

第一版建议提供“基于这些材料写稿”“改得更自然”“缩短并保留关键信息”“改成另一种格式”四种常用任务，使用完整可复制文本和可保存 Markdown，不加入发布平台操作。短任务可由主智能体加载技能完成，长文或与研究串联时再交给专家。

研究与写作交接应传报告、来源清单、允许采用的结论和未核实项；不能只传一段可能遗漏限制条件的摘要。

证据：[写作定义](D:/code/personal-project/Orkas/resources/builtin/marketplace/agents/173d4235a431/agent.json)、[写作技能](D:/code/personal-project/Orkas/resources/builtin/marketplace/skills/9dfbd4e00c0d/SKILL.md)。

### 4.3 办公文件与 PPT：投入较大，但能明显拓宽应用用途

Orkas 将两种任务分开：OfficeWorker 做办公文件读取、轻改和批量处理，PptMaker 负责叙事、视觉设计和整套演示稿。PPT 的创建、编辑、审查和大纲各有路线，并保留可编辑的原生对象。

它们依赖实际宿主工具，例如 `create_docx`、`create_xlsx`、`create_pptx`、`office_read`、`edit_office`、`office_review`，底层是随应用分发的 OfficeCLI。工具处理路径、文件锁、常驻进程关闭、结构检查与页面渲染，并返回产物路径和版本标识。

我们当前默认工具目录没有相应办公能力；更直接的缺口是附件路由会将 PDF、DOCX、XLSX、PPTX 等文档标记为 `attachment_document_unsupported`。添加 OfficeWorker 角色无法自动修复这个入口。

建议按顺序推进：

1. 文档读取：附件保存后，通过已验证的解析工具提取文本、表格、页／工作表位置和覆盖范围。
2. 新建文件：先保证新 DOCX、XLSX、简单 PPTX 能生成、打开和检查。
3. 小范围修改：明确源文件、工作副本、改动对象和当前成品，保护无关内容。
4. 高设计 PPT：补叙事规划、逐页渲染和整稿审查。

首版不承诺完整保留宏、复杂动画、嵌入对象或所有旧 Office 格式。选择复用 OfficeCLI 还是使用现有文档库，需要另做引擎验证；本次只确认 Orkas 的实现路径，不作运行质量保证。

验收示例：拖入 XLSX 后能从真实数据计算并生成保留公式的结果；“只改第 4 页”不会重建其余页面；不能生成或验证时给出明确原因，不能以改文件扩展名冒充成品。

证据：[办公定义](D:/code/personal-project/Orkas/resources/builtin/marketplace/agents/a19101ba698a/agent.json)、[PPT 定义](D:/code/personal-project/Orkas/resources/builtin/marketplace/agents/7e91cb9ec9e9/agent.json)、[办公工具](D:/code/personal-project/Orkas/src/main/model/core-agent/office-tools.ts)、[引擎封装](D:/code/personal-project/Orkas/src/main/features/office/office_engine.ts)、[我们的附件路由（第 72 行）](D:/code/personal-project/OpenHarness-ts/packages/server/src/application/attachments/routing/attachment-capability-router.ts)。

### 4.4 UI 与图片：先吸收持续修改，再扩展制作工具

UIDesigner 将独立设计保存在固定目录，默认包含 `index.html`、`artifact.json` 和按需存在的 `assets/`。后续修改复用同一目录、保留用户改动和资源路径，通过检查后增加版本。它还附带 Node 编写的 HTML 产物检查脚本，可作为较轻的复用候选。

ImageStudio 根据画面需要选择 HTML/SVG 排版、排版加生成素材、直接生成或编辑原图。海报中的准确文案、Logo 与布局尽量用确定的排版实现。模型生成和导出则依赖 Orkas 的 `generate_image` 与 `image_studio` 宿主能力，不能直接照搬调用。

对我们最有价值的是：“改这张图的标题”“继续修改刚才的设计”始终命中当前产物。建议先建立产物记录并支持 HTML/SVG，完整图片能力再加渲染、导出、供应商配置、调用预算和失败恢复。UI 专家读取源码与修改源码的权限应分开。

证据：[固定产物约定](D:/code/personal-project/Orkas/resources/builtin/marketplace/agents/bcfcb4921dce/skills/ui-artifact-workspace/SKILL.md)、[HTML 检查](D:/code/personal-project/Orkas/resources/builtin/marketplace/agents/bcfcb4921dce/skills/ui-design-executor/scripts/validate-html-artifact.mjs)、[图片路线](D:/code/personal-project/Orkas/resources/builtin/marketplace/agents/814b61b027f0/skills/image-router/SKILL.md)。

## 5. 与 OpenHarness 对接时必须处理的差异

### 5.1 原生插件可以承载专家，但普通对话看不到所有插件专家

我们支持 `.vykor-plugin/plugin.json`，可以装载 Agents、Skills、Node Tools、MCP 和插件 UI。Agent Markdown 被转换成带插件前缀的名称，技能也保留插件归属。

`createRunCapabilityView` 只让当前选中插件及基础能力进入本轮运行；子智能体继承这个范围。因此，将 Research 与 Writing 分装成两个插件，不会自然获得普通对话中任意跨插件调度的能力。

可行路径：

- **最小试点：** 一个知识工作插件包含研究、写作、资料整理及其检查工具。用户通过现有插件选择入口启用后，在同一插件范围内调度多个专家。
- **开箱体验：** 将经过筛选的专家作为应用内置能力发布，或增加由应用维护的可用专家目录与明确的启用规则。具体实现要另行设计，不能通过把所有插件工具暴露给普通对话实现。

专家目录应显示任务、能交付什么、当前是否可用及缺少的依赖。用户通常选择“研究”“写文章”“做 PPT”，内部再决定由谁执行。

证据：[插件 Agent 加载](D:/code/personal-project/OpenHarness-ts/packages/plugins/src/components/agents.ts)、[插件 Skill 加载](D:/code/personal-project/OpenHarness-ts/packages/plugins/src/components/skills.ts)、[本轮能力筛选（第 20 行）](D:/code/personal-project/OpenHarness-ts/packages/agent-runtime/src/node/plugins/run-capability-view.ts)、[现有输入入口](D:/code/personal-project/OpenHarness-ts/apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/composer-picker-plugin.tsx)。

### 5.2 插件能力已经注入，专家专属技能声明是另一层

当前选中插件的技能、工具和智能体已经进入本轮能力范围；子智能体继承这个范围，工具还会按 Agent 的允许／禁止列表进一步筛选。现有插件准备错误和 MCP 依赖也有检查。因此，不能把下面的字段处理差异理解为“现有插件不会注入能力”，也不应把新增一套绑定机制列为两个专家试点的必要前提。

Agent 加载器会解析 `skills`、`memory` 等字段。但已检查的 Agent 调度路径和 Workflow 调度路径没有把 `agentDef.skills`、`agentDef.memory` 传入子运行；子能力范围的派生主要筛选工具和 MCP，并未按专家技能列表筛选。

此外，自定义专家提示词会走 `customPrompt`，不能仅凭定义里写了技能列表，就认为默认技能说明一定被拼进提示词。现有 Skill 工具仍可读取当前范围允许的技能；这里的缺口是明确的专家依赖注入、选择与运行校验。

第一版可以直接在专家提示词中写明要通过 Skill 工具加载的真实技能名称，以及插件检查工具的调用方式，复用现有能力范围和权限检查。只有需要自动消费 Agent 的 `skills` 声明、强制按专家缩小技能范围或额外检查领域运行组件时，再扩展这层机制；这些属于可选增强。缺失的实际运行组件应返回清晰错误。

证据：[字段解析](D:/code/personal-project/OpenHarness-ts/packages/coordinator/src/agent-loader.ts)、[Agent 调度参数（第 120 行）](D:/code/personal-project/OpenHarness-ts/packages/tools/src/agent/agent-tools.ts)、[Workflow 调度参数（第 126 行）](D:/code/personal-project/OpenHarness-ts/packages/tools/src/agent/workflow/runner.ts)、[子运行能力派生（第 110 行）](D:/code/personal-project/OpenHarness-ts/packages/agent-runtime/src/node/children/child-agent-options.ts)、[提示词组装（第 251 行）](D:/code/personal-project/OpenHarness-ts/packages/agent-runtime/src/node/runtime/default-runtime.ts)。

### 5.3 工具组、脚本入口和运行环境需要转换

Orkas 的 `workspace.read`、`office.presentation`、`media.image` 是能力分组；我们的 Agent `tools` 是实际工具名称列表，不能原样填入。Orkas 的脚本通过安装 ID、当前用户、专家归属和语言选择解释器，还依赖自己的目录和环境变量。

集成时应将角色、流程、质量标准转成 Agent Markdown；将共享与私有技能依赖解析成实际技能；为可复用脚本提供真实工具或受控运行入口。文件、网络、进程操作沿用现有权限、超时和取消机制。Windows 的 Native／WSL 模式必须同时考虑文件路径、解释器和二进制位置，不能只在宿主进程中硬编码 Windows 路径。

试点只需要转选中的能力包，没必要先造一个能转换全部 Orkas 资源的通用导入器。

证据：[我们的默认工具目录（现归 Node）](../packages/agent-runtime/src/node/tools/default-tool-registry.ts)、[原生插件示例](D:/code/personal-project/OpenHarness-ts/examples/plugins/text-inspector/.vykor-plugin/plugin.json)、[Orkas 工具分组目录](D:/code/personal-project/Orkas/src/main/model/core-agent/tool-catalog.ts)、[Orkas 脚本运行入口](D:/code/personal-project/Orkas/bin/run-skill.cjs)。

### 5.4 已有文件入口和插件 UI，仍需补“当前成品”记录

我们已有文件变更汇总、文件打开、图片预览、子任务展示和插件 UI，可以复用。它们分别解决浏览文件、观察任务或与插件交互的问题。

专业成果可以先在固定工作目录里记录当前文件、来源和检查结果，由技能约定后续修改读取它们；这不要求先建立应用级成果数据库。只有需要跨会话统一查找、结构化成品卡片或可靠版本关联时，再增加产物身份、类型、创建专家、版本和所在子会话等应用级记录。后续修改应读取当前文件，避免仅凭聊天中的文件名猜当前版本。

对话里的成品卡片建议提供“打开”“继续修改”“导出”；展示真实执行的检查，例如“结构已检查，未检查视觉效果”。HTML 设计稿需明确采用受限预览或外部打开，现有静态插件 UI 不能直接等同于任意生成 HTML 的托管能力。

证据：[文件变更汇总（第 185 行）](D:/code/personal-project/OpenHarness-ts/apps/desktop/src/renderer/src/components/desktop/conversation-page/message/models/message-render-model.ts)、[文件打开](D:/code/personal-project/OpenHarness-ts/apps/desktop/src/main/features/workspace/opener-service.ts)、`插件 UI`（旧实现已移除）、[Orkas 办公产物版本回执（第 53 行）](D:/code/personal-project/Orkas/src/main/model/core-agent/office-tools.ts)。

### 5.5 专家记忆与自动学习后置

Orkas 有按专家注入的记忆、反思运行和学习技能存储。我们已有记忆整理能力，第一阶段可用项目资料、来源记录和产物状态解决继续工作的问题。

先不照搬任务后自动改写技能：它会引入额外模型调用、错误经验持久化和共享／私有技能治理。后续只保存明确的用户偏好和验证过的经验，并提供查看、删除和恢复手段。本次未评估 Orkas 自动学习的实际效果。

证据：[Orkas 专家记忆注入（第 633 行）](D:/code/personal-project/Orkas/src/main/model/core-agent/runner.ts)、[反思工具范围（第 1187 行）](D:/code/personal-project/Orkas/src/main/model/core-agent/runner.ts)、[我们的记忆能力组装](D:/code/personal-project/OpenHarness-ts/packages/agent-runtime/src/node/capabilities/default-agent-capabilities.ts)。

## 6. 推荐推进顺序与体验验收

| 阶段 | 做什么 | 用户能直接感知的变化 | 验收重点 |
|---|---|---|---|
| 第一阶段 | 同一个知识工作插件：研究、写作、资料整理；声明真实技能与工具；适配检查脚本；用固定目录保存当前产物 | 选择能力后，从网页／MD／文本／CSV 得到完整报告或稿件，接着修改 | 来源对应结论；成品真实存在；不重复索要已提供信息；后续命中同一成果 |
| 第二阶段 | 文档附件读取、办公引擎、OfficeWorker 与 PptMaker | 拖入办公资料，得到能编辑的 Word／Excel／PPT | 解析覆盖范围；文件能打开；公式与对象可编辑；修改保留无关内容 |
| 第三阶段 | UIDesigner 与 ImageStudio 排版能力，补预览与导出 | 从设计目标到可继续修改的 HTML／SVG／图片 | 当前版本正确；文案准确；导出真实；不以结构检查冒充视觉检查 |
| 后续扩展 | SEO、电商，随后语音和视频专项 | 专业任务按需启用，依赖缺失时有清楚说明 | 数据和连接器可用性；真实媒体生产；费用与失败恢复 |

研发专家可以同步改善提示词和验收标准，无须为它单独建立一套运行框架。第一阶段先验证两项能力的稳定性，再扩展专家数量。

完整流程建议是：用户从对话进入 → 选择可用能力或由内置目录匹配 → 应用检查依赖 → 主智能体直接做或创建专业子会话 → 专家读取当前资料／产物 → 工具生成并检查 → 记录文件和版本 → 对话返回成品 → 后续请求继续修改。

中断时沿用我们现有运行状态记录，明确标为中断；用户继续后从保存资料恢复，不能把“状态能保存”描述为“进程重启后自动续跑”。

评价效果应关注真实交付率、首次成品可用率、无关内容保留、继续修改是否找对文件，以及依赖失败是否明确。模型会话数量、总耗时和调用费用作为效率指标；本次没有数据，暂不设置虚构的改善百分比。

## 7. 复用边界与未验证项

Orkas 根目录为 MIT 许可，直接复用实质代码或技能内容时应随分发保留原版权与许可。它带入的 OfficeCLI、媒体组件、模型和素材需分别核对版本、许可与分发条件；根项目许可不能替代这些组件的条件。此处记录仓库许可事实，不构成法律判断。

本次验证了资源数量、全部智能体的技能依赖声明，以及上述关键调用与界面代码。没有执行 Orkas 技能脚本、办公引擎、网络检索、模型调用、视频／语音渲染，也没有证明成品质量。没有修改应用代码或运行完整测试套件。

在真正集成前，重点验证：原生插件内研究写作串联；文档附件的解析与错误行为；办公引擎跨平台创建／修改／渲染；HTML 产物的加载边界；子任务取消和恢复；脚本与当前运行环境的路径映射。

许可证据：[Orkas LICENSE](D:/code/personal-project/Orkas/LICENSE)、[OfficeCLI 获取与分发脚本](D:/code/personal-project/Orkas/scripts/fetch-officecli.cjs)。资源核对明细另存于 [inventory.json](D:/code/personal-project/OpenHarness-ts/docs/research/orkas/inventory.json)。
