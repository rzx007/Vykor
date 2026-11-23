# Vykor Windows Computer Use 接入计划

> 状态：实施计划。按同一条实现线分阶段交付。平台范围为 Windows x64 本机 Desktop。
>
> 执行时逐阶段完成复选框。先用真实边界写能发现问题的测试，再实现和复跑。每个阶段通过它的验收条件后进入下一阶段。

**目标**　用户在 Vykor 里说「打开记事本，写三行会议待办，另存到我选的测试目录，再用资源管理器检查」，即使这些应用都没开，Vykor 也能找应用、获得许可、启动或复用窗口、执行多步操作，并用应用状态或产物回答实际完成了什么。用户能看到进度、暂停接管、继续或停止。

**实现方式**　Vykor Desktop 负责发现和启动应用、核对窗口身份、提示前台占用和停止输入。daemon 负责将本机许可绑定到一次 Agent 运行，以及装配工具、记录动作和返回结果。Cua 负责读窗口和操作控件。Windows UI Automation 让驱动通过操作系统读取并请求按钮、文本框和菜单等控件。需要时再使用指定窗口的画面和有边界的前台键鼠。

**交付范围**　覆盖普通 Windows 应用和受支持的系统界面，包括打开应用、浏览文件、编辑和保存、跨应用窗口交接、读取普通应用或系统设置，以及执行用户要求且可核验的非敏感设置变更。管理员提权、系统安全桌面、认证和需要真人完成的敏感流程走接管。网页任务继续使用 Vykor 的 [Browser](../../browser-capabilities.md) 能力。Windows ARM64、macOS、Linux、远程控制和锁屏操作各有独立的平台验收。

## 产品体验

1. **一句任务开始。** 用户在聊天中启用 Computer Use，可以直接写「打开计算器算 27×14 并告诉我结果」，也可以显式选择 Computer 工具入口。开关默认关闭。识别依据是 Desktop 中的用户输入和开启状态。网页、文档、控件文字与模型输出均当作外部上下文，无法开启该能力。
2. **Vykor 找应用和窗口。** 在本机已安装的目录中解析用户指的应用。若找到唯一且匹配的已运行窗口，直接复用；应用未运行时，按应用许可启动并等待可操作窗口。手动选窗用于多个文件或窗口都符合条件、应用归属无法核实，或者用户想纠正目标。
3. **应用授权后连续工作。** 第一次使用未授权应用时，询问是否仅允许本次任务，或将该应用设为始终允许。始终允许可在设置中撤销。许可限定到受识别的本机应用并由实际任务激活。它涵盖许可范围内的普通观察、点击、编辑、滚动和导航。跨入未授权应用、占用前台键鼠、向外发送、删除或覆盖、支付及重要系统变更时，分别检查当前任务范围，并在适用时停下来要求明确确认或接管。
4. **看得见，也接得回来。** 运行区显示正在查找、启动、等待许可、操作、核验或已暂停，以及当前应用、窗口和最近动作。授权时可展开指定窗口预览。前台输入前显示它会使用当前桌面的鼠标和键盘。用户可暂停接管，完成登录、处理对话框或纠正位置后，点继续让 Agent 重新观察。Stop 立即拦住新的派发，已进入应用的动作仍可能继续。
5. **用可核实的结果结束。** 比如计算器屏幕实际显示 378，或用户指定的文件已经保存且重新打开后内容吻合。只收到点击成功回包、没读到应用结果时，明确说已发送且效果待确认。任务结束后清除当前窗口引用与操作许可，并释放输入。

### Codex 交互参考

OpenAI 的官方说明明确支持从自然语言或应用提及启动任务、按应用授权、记住和撤销允许的应用、在敏感或干扰性动作前追加确认，以及随时停止或接管。Windows 上的 Codex 在活动桌面进行前台操作，macOS 的后台和锁屏能力有各自的条件。Vykor 借鉴其任务入口、权限分层和接管体验，Windows 的实际交付方式按 Cua 的实机结果确定。 [OpenAI Computer Use 指南](https://learn.chatgpt.com/docs/computer-use)

### Windows 实测基线

本机上游 Cua `0.28.2` 已验证指定窗口观察、截图、后台点击和赋值、过期引用拒绝、常规前台键鼠按下与释放。窗口级 `bounded` 清单会拒绝同进程未授权窗口和按进程 ID 枚举。驱动的工具目录仍返回 57 个工具，Vykor 自行筛选向模型开放的动作。

真实记事本已从关闭状态启动，写入后保存，通过资源管理器重新打开，文件字节和编辑器内容均已核验。现代记事本会恢复上次的标签页，探针用单独的新窗口。另存为的文件名控件需要在明确核对焦点后使用前台输入。测试中驱动关闭后，已进入应用的延迟动作仍继续约 1.9 秒。前台急停、失焦和物理接管的验收保留在阶段 5。 [实机结果和复现方式](../../../apps/desktop/tests/computer-windows/README.md) · [Cua 固定发布](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.2)

```mermaid
flowchart LR
  A["1 驱动和真实应用探针"] --> B["2 本机桥与任务授权"]
  B --> C["3 自动选目标与启动"]
  C --> D["4 结构化观察、语义操作与读回"]
  D --> E["5 前台输入、预览与接管"]
  E --> F["6 签名安装包与完整验收"]
```

阶段 1 至 5 使用夹具和内部开关合入同一条实现线。阶段 1 提前探测真实应用路径，阶段 5 一次验收前台输入及接管，阶段 6 用签名安装包验收完整用户旅程之后开放。

## 代码目录与状态归属

沿用现有 Browser 的分工。Desktop 代码归 `apps/desktop`，daemon 代码归 `packages/server`。按阶段新增有实际调用的文件。

```text
apps/desktop/
├── src/main/features/computer/
│   ├── README.md
│   ├── ipc.ts                     本机用户控制入口，校验所属 Desktop 窗口
│   ├── computer-bridge.ts         连接 daemon，转发请求、结果和取消
│   ├── computer-host.ts           选择和切换目标、校验许可、协调单个在途动作
│   ├── computer-semantics.ts      生成控件引用、判断是否需批准、验证读回
│   ├── windows-apps.ts            发现和启动应用，核实窗口身份和存续
│   ├── windows-driver.ts          验签并运行 Cua，合并指定窗口的控件观察
│   ├── windows-semantic-query.ts  用 Windows 辅助功能接口核对控件并派发
│   ├── windows-foreground.ts     管理窗口截图及本轮前台输入进程
│   ├── windows-foreground-query.ts  核对实际焦点、画面和 Windows 键鼠释放
│   └── __test__/
├── src/shared/computer-types.ts   主进程、preload 和 renderer 共用的桌面状态及控制参数
├── src/renderer/src/components/desktop/tools/computer/
│   ├── README.md
│   ├── computer-panel.tsx         运行状态、目标选择、窗口预览和接管入口
│   └── __test__/
└── tests/computer-windows/
    ├── README.md
    ├── fixtures/                 自有测试应用、对照窗口和验收资料
    └── __test__/                 冷启动、跨应用读回、前台停止的整体验收

packages/server/src/
├── application/computer-tools/
│   ├── README.md
│   ├── computer-tool.ts          Computer 工具定义、入参校验与结果转换
│   ├── computer-bridge.ts        可信 Desktop 连接、在途请求与断开处理
│   ├── computer-approval.ts      将单次批准绑定到实际运行和输入修订
│   ├── computer-bridge-protocol.ts
│   │                             两端共用的私有桥消息及解析器
│   └── __test__/
├── http/routes/computer-host.ts   HTTP 认证、请求尺寸检查与路由包装
└── http/__test__/computer-host.test.ts
```

- **调用路径**　用户控制由 `ipc.ts` 进入 Desktop 的 `computer-host.ts`。模型调用由现有 Agent 运行进入 daemon 的 `computer-tool.ts`，经两端的桥到同一个 Desktop 宿主，再由 `windows-apps.ts` 或 `windows-driver.ts` 执行。结果经原请求返回，进入现有工具记录。接线见 [Desktop 会话入口](../../../apps/desktop/src/main/features/session/ipc.ts)、[daemon 连接](../../../apps/desktop/src/main/features/session/daemon-connection-service.ts)、[运行准入](../../../packages/server/src/application/session/execution/run-admission-service.ts) 和 [运行工具装配](../../../packages/server/src/application/session/execution/session-run-executor.ts)。
- **状态归属**　`computer-host.ts` 持有当前目标、本轮许可、最新观察、前台占用和唯一在途动作。应用的「始终允许」沿用本机 Desktop 设置。daemon 持有运行、审批和工具结果。两端的桥只维护请求关联。renderer 通过已有 [IPC 通道](../../../apps/desktop/src/shared/ipc-channels.ts)、[桌面 API 契约](../../../apps/desktop/src/shared/desktop-api-contract.ts) 和 [preload](../../../apps/desktop/src/preload/desktop-api.ts) 读取本机状态并发起用户操作。聊天进度沿用会话事件，界面沿用现有组件，确需新增时先查 beUI。 [Desktop 设计约定](../../../apps/desktop/DESIGN.md)
- **协议边界**　私有桥协议和服务端实现放在同一个目录，经现有 `@vykor/server/daemon-host` 导出 Desktop 主进程实际需要的类型和解析器。公开的运行能力接口只公告 Computer 桥是否就绪。renderer 和 preload 使用桌面自己的类型，获取不到配对凭证、窗口句柄和原始驱动引用。 [Browser 现有导出](../../../packages/server/src/daemon-host/index.ts) · [运行能力路由](../../../packages/server/src/http/routes/system.ts)
- **原生辅助程序与打包**　确需自有原生辅助程序时，将源码放在 `apps/desktop/native/computer-windows/`。固定驱动发布清单放在 `apps/desktop/resources/computer-windows/`。`scripts/prepare-cua-driver.mjs` 准备并核验驱动，Windows x64 构建通过 `extraResources` 将驱动、清单和许可证装入安装包。 [资源打包](../../../apps/desktop/electron-builder.yml) · [标签发布](../../../.github/workflows/tag-release.yml) · [第三方许可](../../../THIRD_PARTY_NOTICES.md)
- **测试与导航**　模块测试放本模块的 `__test__/`。覆盖多个模块的测试放它们共同所属目录，如 daemon 的 HTTP 测试和 Desktop 的 Windows 实机验收。创建职责目录时同步写 README，说明用途、主要文件、调用入口、关键步骤、状态归属和新增代码应放在哪里。更新所属包 README 的导航。夹具目录有多个独立夹具时再按职责拆分。 [Desktop 包导航](../../../apps/desktop/README.md) · [daemon 应用目录导航](../../../packages/server/src/application/README.md)

## 共用工具、权限和结果契约

### 工具面

拟将 Vykor `Computer` 暴露为以下受限动作。应用和窗口引用由宿主在本轮签发。原生 PID、窗口句柄、路径、启动参数和驱动令牌留在可信端。

| 动作 | 输入与返回 | 关键约束 |
| --- | --- | --- |
| `open_app` | 输入应用名和可选窗口或文档提示，也可引用本轮已知目标。宿主查找、授权、复用或启动，并绑定就绪窗口。 | 候选歧义时显示选择器，用户选择后续办同一次请求。跨应用或切换到其他合格窗口沿用这个入口。 |
| `observe` | 返回结构化控件，有许可时可附当前窗口画面。 | 默认结构化信息。限制节点数、深度、文本与图片体积。 |
| `invoke`、`set_text`、`choose`、`scroll`、`press`、`click_at` | 使用本轮、当前窗口及最近观察产生的元素引用或有限坐标。 | 语义优先。坐标绑定同一窗口的快照。前台输入需要独立许可与已实测的停止能力。 |

`invoke` 触发按钮和菜单命令，`choose` 设置可读回的选项状态，`set_text` 使用控件的赋值接口。普通文本框无法语义赋值时，才评估目标窗内受控键盘输入。受支持的键和动作按实际验证登记。文件选取用用户在任务中授权的文件或目录。能够提交数据、启动程序或越出目录的输入单独验权限。操作返回直接读回，复杂结果用 `observe` 或现有的获准产物读取核验。在动作前已满足的条件记录为原先已满足。

### 四层判断

- **任务许可**　Desktop 启用状态和顶层用户输入与真实 `sessionId/runId/inputId` 绑定。连接重建、排队重放、子任务、工作流或其他客户端不能借用。浏览器页签和插件权限保持独立。
- **应用许可**　宿主按 Windows 应用目录、安装身份和可执行来源发放「仅本任务」或用户明确保存的「始终允许」。始终允许只减少应用级提示；当前使用仍受任务、窗口、操作风险和系统权限限制，设置里可撤销。新应用、候选冲突、发布者或身份变化均复核。存储持久选择，不持久化窗口或输入票据。
- **窗口许可**　Electron 核对登录会话、进程创建时间、句柄归属和窗口实例，给 Cua 一个当前窗口的 `bounded` 清单。发现与启动由受信任的 Desktop 启动器完成。切到别的窗口时，暂停派发，释放旧观察和驱动窗口权限，再按新目标建清单。句柄复用、弹窗归属含糊、锁屏、失去监听或截图几何变化均重新验证。
- **操作许可**　任务许可覆盖经过确定性策略判定的普通操作。派发前结合请求、应用、控件语义、截图范围与当前状态判断。可能是发送、删除、覆盖、系统更改等高影响动作或效果无法可靠归类时，走真正的人工确认；可暂停让用户完成。前台键鼠使用单独显式许可并占用同机输入。提权、安全、认证等窗口由用户接管。通用的 `full_access` 和 `auto_review` 保留其现有含义，均无法代签这些真人批准。 [Vykor 运行权限](../../../packages/permissions/src/index.ts) · [会话审批](../../../packages/server/src/permissions/session-approval.ts)

### 状态和证据

- Electron 是本机窗口、前台占用、暂停、停止和输入释放状态的唯一来源，桥断开时本机接管仍可用。daemon 沿用运行、审批、工具进度和结果的现有记录。查找、启动、核验等由当前工具进度呈现，聊天界面合成这些事实来展示过程。
- 桥只记录当前连接的在途请求，沿用 `ToolContext` 的工具调用身份、截止时间和取消信号。Core 的 `serialGroup` 负责同一运行中的工具排序。Electron 每次最多接纳一个任务持有输入，最多向驱动发出一个在途动作。冲突时返回占用原因，停止时撤权并取消在途请求，重连从新请求开始。 [轮内串行](../../../packages/core/src/engine/tools/checked-tool-execution.ts) · [现有在途请求管理](../../../packages/server/src/application/browser-tools/browser-bridge.ts)
- 用现有 ToolResult 返回执行结果。Electron 能证明未向 Windows 派发时，单独保留该事实，即使 Core 已进入工具函数。已派发且效果未知使用 `executionState: "unknown"`，保留重新观察的提示，恢复写入须通过新状态检查。许可失效后的回包丢弃旧窗口内容，派发事实仍记入本轮结果。 [Core 结算](../../../packages/core/src/engine/tools/checked-tool-execution.ts)
- 一处捕获授权窗口的画面，分别检查谁能预览、发送给模型或保留证据。预览默认短时存在且不落盘。模型图片需任务授权并满足模型能力。证据留存沿用会话访问及保留策略。诊断只记录动作标识、耗时和结果类别。

## 阶段 1 · 固定驱动并探测真实应用

**交付**　复现上游 Cua PoC，并在写产品桥接和界面前验证 Windows 应用的真实操作路径。2026-11-23 实机通过，复跑命令、证据和输入限制见 [Windows 实机验证](../../../apps/desktop/tests/computer-windows/README.md)。

- [x] 将 PoC 的同 PID 双窗、计数、赋值与延迟应用动作移入 `apps/desktop/tests/computer-windows/`。增加检测目标窗重建、已关闭应用的启动、同名应用或文件的测试结构。由夹具内部日志给实测提供基准。
- [x] 固定 Cua `0.28.2` Windows x64 ZIP 的 SHA-256 `1f4bfceeab64cb7f56be7aad774c3dc2d2910d1427e4be1d79939c706e8029ba`。核对解包后的必需文件 SHA-256、架构和适用的厂商 Authenticode 签名。将资源路径固定在已核对的安装目录。工具帮助、版本探测和真正启动一律从第一个进程起设 `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`，关闭更新检查和外部 MCP 监听，使用独立的临时数据目录。 [现有固定资源模板](../../../scripts/prepare-office-engine.mjs)
- [x] 用 Desktop 已有 MCP SDK 通过专属标准输入输出验证 `cua-driver mcp --direct`。复测窗口清单、旧引用拒绝、截屏、读回、退出和后代进程清理。先使用这一条产品接入路线，原命名管道保留为 PoC 对照。 [Desktop 依赖](../../../apps/desktop/package.json)
- [x] 写一个薄脚本，从记事本和目标资源管理器窗口未打开开始。通过 Windows 注册入口启动，限时查找并确认唯一窗口。写入测试文字，经保存对话框另存到专用目录，再由资源管理器打开，核对窗口内容与文件字节。记录每个环节实际使用语义还是画面输入，并在自有夹具单独探测前台键鼠释放。窗口等待先用统一的身份复查和超时，按实测失败补具体分支。
- [x] 用最小 Windows x64 解包产物确认 Cua 文件字节和原厂签名在打包后可验证。核对 Vykor 安装器与辅助程序签名的实际来源和验证步骤。签名凭据未就绪时，作为阶段 6 的发布依赖记录。 [当前 Windows 发布步骤](../../../.github/workflows/tag-release.yml) · [安装产物检查范例](../../../apps/desktop/scripts/verify-office-packaging.mjs)
- [x] **阶段通过条件**　PoC 可重复，窗口权限、过期引用和驱动退出有证据。真实冷启动、保存和跨应用读回路径有可复查的结果。发现身份、输入或清理缺口时，先解决对应的驱动或 Windows 系统路径，再扩展产品接口。

## 阶段 2 · 本机桥与本次运行授权

**交付**　任意普通客户端请求无法领取本机权限，已授权的 Desktop 主任务能装配限域 Computer 工具。2026-11-23 验收通过。

**Windows 启动通道探测**　当前项目安装的 Electron 可作为无窗口、分离的子进程，经 `child_process.spawn` 继承的 Node IPC 完成一次挑战应答。测试核对了实际子进程 ID，双方关闭 IPC 后，父进程退出，子进程仍能运行。按需启动已使用这条通道配对。Desktop 核对实际子进程、已登记实例和数据根后关闭启动通道。两端只在内存中保存独立凭证。

**阶段 2 实测**　Windows x64 用隔离数据根运行项目的无窗口 daemon 入口。继承通道完成配对后，普通会话 API 和私有流均可用。只有普通 API 凭证的请求无法接入私有流，未配对启动的 daemon 仍提供普通 API。跨包测试用离线模型和假 Windows 宿主走通 Desktop 私有提交、Computer 派发和结果回传。断线时，一次性审批过期，旧连接的结果被拒绝。重启保护测试覆盖运行中任务、临时聊天、旧端口和安全收尾响应丢失。 [Desktop 集成测试](../../../tests/desktop-integration/README.md) · [daemon 测试入口](../../../packages/server/src/application/computer-tools/README.md)

- [x] 复用 [Browser 宿主路由](../../../packages/server/src/http/routes/browser-host.ts) 的本机绑定、来源头校验、请求上限和断开处理。为 Computer 保留独立凭证。Desktop 按需启动 daemon 时，经继承的私有进程通道交换凭证，核实实际子进程与注册实例、数据根一致后关闭启动通道。凭证只留在双方内存。普通 API token、请求 metadata、命令行和日志均无权发放凭证。 [按需连接](../../../apps/desktop/src/main/features/session/daemon-connection-service.ts) · [后台进程启动](../../../packages/client/src/service/process.ts)
- [x] 验证 Electron IPC 的实际主窗口后，经可信 Computer 通道提交一次正常的用户消息。复用现有准入，在首次创建输入和运行、尚未入队时绑定资格。重复提交和恢复继续走现有去重分支，且不重新发放许可。任务启动无需已有窗口。按 `AgentRunToolContribution` 装配范围内的工具，`beforeDispatch` 检查运行资格。真实目标窗和前台输入的许可由 Desktop 在后续对应阶段接通。计划模式、远端、CLI、Web、渠道、定时和委派无法继承资格。 [入队前的原子创建](../../../packages/server/src/application/session/execution/run-admission-work.ts) · [派发校验](../../../packages/server/src/application/session/execution/tool-dispatch-check.ts)
- [x] 同一 Desktop 对同一后台实例在短暂掉线后可以重新认证，清空旧许可、旧审批和旧观察。Desktop 重启后先正常连后台。用户发起 Computer 时，只在当前实例可核实为 Desktop 按需启动、当前仍采用按需启动配置、没有在途或排队运行且通过临时聊天保护时，复用现有的受控重启流程重新配对。无法安全替换时保留原后台和普通会话，Computer 显示不可用原因。 [维护时的重启保护](../../../packages/server/src/application/maintenance/maintenance-application-service.ts) · [已注册进程终止校验](../../../packages/server/src/daemon-host/lifecycle.ts)
- [x] 用实际路由和假驱动测伪造 metadata、重复和恢复、跨来源运行、待审批断线、旧回复、握手实例竞争以及 Desktop 重开。复用现有审批服务的待决请求、过期、取消和记录。可信真人回复在阶段 4 用于逐次确认高影响动作，在阶段 5 用于同意一段连续前台占用。
- [x] **阶段通过条件**　一次可信提交即可开跑。未授权或已失效的来源触达驱动为零，旧连接回包不会触发新动作。普通聊天、Browser 和独立 daemon 通过回归。遇到在途任务或临时聊天时保持原后台。

## 阶段 3 · 找应用、自动启动与窗口接续

**交付**　从聊天开始可处理已运行和未运行的应用，能够找到节奏明确的窗口和受支持的跨应用目标。2026-11-23 验收通过。

Desktop 主聊天的「电脑操作」用于本次发送。发现应用后，先核对应用许可，再复用唯一匹配的窗口，或从 Windows 的应用登记启动并等待就绪。只有多个合格目标时才显示选择。首次应用许可、同名选择与复查都走相同的私有桥。设置中的已保存许可可撤销。 [Desktop 接入与状态](../../../apps/desktop/src/main/features/computer/README.md) · [Windows 实机命令](../../../tests/desktop-integration/README.md)

**实机结果**　Windows x64 下通过实际 Desktop 私有桥与 daemon，用默认权限模式和离线模型从关闭状态启动计算器与画图。切回计算器时核对了同一窗口句柄、进程和创建时间，未显示选择器。注册的 Win32 夹具也从关闭状态启动，两个同名文档只显示一次选择，随后复用已选文档并自动接续所属的普通模态对话框。验收结束后核对了窗口、测试进程和注册快捷方式均已清理。 [实机用例](../../../tests/desktop-integration/__test__/computer-windows-live.test.ts)

- [x] 在 `windows-apps.ts` 封装传统桌面程序和打包应用的可信发现、启动和窗口复查。应用候选只提供名称、运行状态和本轮引用，区分应用身份和显示名。用本机注册入口或已核实的应用身份启动，参数由宿主确定。限时确认窗口的登录会话、进程创建时间、归属、实例和实际文档。
- [x] 贯通 `open_app`。有唯一匹配的窗口时核实并复用。没有时按应用许可启动并等待。多个合格窗口、应用或文档时显示选择器，继续同一个操作。分别报告找不到、等待超时和应用已启动但窗口不可用。用阶段 1 的失败样本补启动分支。
- [x] 同一应用中的新对话框和跨应用切换复用同一个窗口绑定流程。归属可证的普通模态窗口可以延用本轮应用许可。其他情况暂停核对。跨应用先检查许可，停止向旧窗口派发、废弃旧观察并为新窗口重新观察。
- [x] 使用 Vykor 的本机运行设置支持查看和撤销始终允许的应用。区分应用未安装、隐私或权限限制和应用虽已运行但不可控制。错误信息告诉用户可行的下一步。
- [x] **阶段通过条件**　用关闭的夹具和至少一个正常 Windows 应用证明从自然语言意图到应用启动和就绪。已开的文档复用、多个同名窗口歧义、新对话框和跨应用许可分别记录测试结果。整个正常路径无需用户预打开应用或预选窗口。

## 阶段 4 · 结构化观察、语义操作与读回

**交付**　Agent 能基于控件树在获准的应用中连续工作，并用真实结果验证动作。2026-11-23 通过阶段验收。

签名 Cua 提供窗口观察。控件的动作与字段值由 Windows 辅助功能接口按窗口和控件身份核对。Cua 在指定窗口找不到可操作控件时可能退回同进程枚举，因此派发和结果核验采用 Windows 核实的目标。写入前比对完整旧值。按钮的回包只报告可观察的变化，文件是否写入仍需重新打开或从获准的文件路径读回。 [Desktop 实现](../../../apps/desktop/src/main/features/computer/README.md) · [实机验收入口](../../../tests/desktop-integration/README.md)

**实机结果**　Windows x64 上用离线模型走实际 Desktop 私有桥和 daemon。测试自动启动一个隔离的记事本测试窗口，写入三行中英文，动作读回和独立观察均对上原文。选择和滚动的结果核验由宿主回归覆盖。WinForms 两个同名窗口中，批准前零点击，单次批准后只触发所选窗口并读到控件变化。夹具未收到模拟键鼠。控件自己的调用有时会让应用取得前台。Stop 在延迟动作已进入应用时撤权，下一次点击未派发，运行进入 `interrupted`，已开始的延迟动作仍自行完成。 [实机用例](../../../tests/desktop-integration/__test__/computer-windows-semantic-live.test.ts)

- [x] 接入控件树、字段值和语义动作。实现受支持的按钮、选择、滚动、编辑和菜单。Desktop 不切换焦点，应用可以自行激活窗口。模型根据每步的新观察决定下一步。目标消失、同名冲突和模态变化废弃旧引用。
- [x] 接通现有审批服务和卡片。高影响动作只接受通过可信 Computer 通道返回的真人批准。批准绑定本次请求、输入修订、窗口和许可世代，由相应的在途动作消费一次。等待期间关闭驱动，获批后重验。日常授权范围内的动作连续执行，无法判断后果时暂停。 [审批服务](../../../packages/server/src/permissions/permission-broker.ts)
- [x] 动作回包直接返回可核实的字段或控件变化。跨窗口跳转用 `observe` 确认实际落点。保存通过重新打开或既有获准文件读取能力核对位置和内容。读回失败时如实报告已发送、效果待确认。核心串行调度和 Desktop 单动作在途检查走同一真实路径。
- [x] 接上聊天 Stop 的本机撤权，在 WinForms 测试夹具中证明先阻止新动作，再取消当前请求与后续轮内动作。PoC 和本阶段都保留延迟按钮回归，分开记录驱动退出和应用效果。
- [x] **阶段通过条件**　任务范围内的语义操作可连续执行。停用、换窗、重复批准或迟到回复后零新派发。单次批准仅触发一次动作。驱动返回成功但应用状态无变化时，结果仍为待确认。

## 阶段 5 · 窗口画面、前台输入与接管

**交付**　窗口画面和前台输入与占用提示、人工接管、本机急停一起实现、一起验收。2026-11-23 完成审查修复和实机复验。

**实机复验**　离线模型经实际 Desktop 私有桥和 daemon 启动 Windows 计算器。按 Tab 后重新截图，运行结束后确认控制进程退出。两个同名 WinForms 窗口验证了失焦、换窗和外部输入接管，旧占用零新派发。实机主动卸载一个观察钩子，目标窗和对照窗都没有新增输入。键盘和鼠标各在按下已进入目标、抬起尚未入队的同步点走实际聊天 Stop，随后在原窗口各收到一次配对抬起，核对了输入释放与子进程退出。真实 HTTP 桥也验证首步前切走并切回，旧任务零派发。 [实际私有桥](../../../tests/desktop-integration/__test__/computer-windows-foreground-live.test.ts) · [WinForms 原生复验](../../../apps/desktop/src/main/features/computer/__test__/windows-foreground-live.test.ts) · [聊天切换回归](../../../tests/desktop-integration/__test__/computer-bridge.test.ts)

键鼠走经核验的目标窗口消息。应用对定向消息的响应仍需读回，依赖真实硬件键态的快捷键可用语义操作或人工接管。截图关闭或暂停会清除本机画面，并撤销 daemon 中尚未发出的截图，请求重试只带文字。退出和更新先关闭新任务入口，未确认释放时暂停安装。 [Desktop 撤权与清理](../../../apps/desktop/src/main/features/computer/README.md) · [daemon 截图处理](../../../packages/server/src/application/computer-tools/README.md)

整体审查后的实机复验覆盖应用自动启动和复用、记事本多行写入和读回、同一窗口改焦点后拒绝旧按键、识别嵌入式认证界面、暂停时报告已派发动作的结果未知，以及 Stop 补发尚未入队的键盘和鼠标抬起。启用 SDK 调试日志时的截图隐私和纯文字重试通过离线回归。 [Windows 实机入口](../../../tests/desktop-integration/README.md) · [原生焦点与认证实机](../../../apps/desktop/src/main/features/computer/__test__/README.md)

- [x] 同一次窗口捕获用于可展开预览和按需的模型图片。坐标输入携带窗口和最新画面引用，宿主核对缩放、窗口边界、遮挡和显示器。键盘输入复核焦点归属。前台许可绑定本轮、当前窗口和这次连续占用。允许范围内的普通动作连续执行，坐标点击和未知后果的输入逐次确认。目标或画面变化时重新观察，接管、失焦或换窗结束此次占用。 [模型图片处理](../../../packages/server/src/application/computer-tools/README.md)
- [x] 在聊天里展示当前应用、窗口、操作方式、最近动作和核验结果。查找、等待许可、启动复用工具进度，前台占用、暂停和停止取自 Electron。用户可在聊天停止，或使用本机快捷键 `Ctrl+Alt+Shift+Esc`。
- [x] 「暂停 / 接管」立即禁止新的派发并释放当前输入。登录或安全对话框交给用户。暂停期间停止读取和截图。继续时重新检查会话、目标和授权，废弃旧窗口及画面引用，重新观察后才打开下一步。
- [x] Stop 先撤销任务许可、审批与当前窗口占用，再取消在途请求并通知后台。本机控制进程报告释放和退出，超时只限时回收本轮进程。Stop 接收、释放、退出和应用动作实际结果分别记录。
- [x] 用实际夹具记录键鼠配对。失焦、同名窗口切换、钩子卸载、外部输入接管和抬起尚未入队时的 Stop 有实机证据。暂停、断线、过期请求和迟到回复有定向回归。无法核实释放时暂停接受新占用。实体输入设备和发布机上的急停复验按阶段 6 执行。
- [x] 聊天停止、关闭 Desktop、锁屏或睡眠、窗口退出、daemon 或控制进程异常、更新安装均撤权。保留 PoC 的延迟动作证据，应用收到的动作效果继续标记为待核验。
- [x] 图像按窗口限域、大小上限和凭据界面规则处理。预览只发给当前任务所属主聊天，关闭捕获、暂停、切换聊天或结束后清除。模型画面只进入当次请求，验收核对聊天历史、SQLite、附件和 JSON 导出。 [会话结果投影](../../../packages/server/src/application/session/transcript/transcript-projection.ts)
- [x] **阶段通过条件**　实际前台动作和安全退出通过验收。未授权、换窗、过期画面或停止后零新派发，按下与释放有应用侧证据。继续前要求重新观察。控制、窗口画面与单次许可在任务结束时回收。

## 阶段 6 · 签名安装包、试点与发布验收

**交付**　从签名的 Windows 安装包完整走通用户旅程，具备升级、停用、排障和回退能力。

Windows x64 安装包随附 Cua 0.28.2。解包和干净 Windows CI runner 的安装验证会核对驱动摘要与原厂签名。Vykor 安装器、宿主、卸载器及升级辅助程序使用各自的签名验证。签名试点只通过 `build_only` 生成工件，正式启用签名前先统一稳定渠道的发布者。签名工件、真实模型、实体输入与升级回退的验收完成后，再开启正式分发。 [打包核验](../../../apps/desktop/docs/packaging.md) · [试点用法](../../computer-capabilities.md)

**本机证据**　Windows x64 NSIS 1.2.31 的解包目录和安装载荷已核对随包驱动。使用解包目录的 Cua 0.28.2 实测了计算器的语义观察、前台批准、截图、Tab、再次截图和清理。静默安装与卸载留在独立 Windows 环境执行。 [复跑入口](../../../tests/desktop-integration/README.md)

- [x] Windows x64 构建预置驱动并核对压缩包和可执行文件的 SHA-256、发布者签名及许可证。CI 检查 Windows 解包和安装后的随包文件，并确认现有 Linux 构建未带入 Windows 驱动。 [资源配置](../../../apps/desktop/electron-builder.yml) · [安装验收](../../../apps/desktop/docs/packaging.md)
- [ ] 用真实模型、普通 Windows 交互账号和签名安装包跑下列验收脚本。生产流程走同一 Desktop 启用、授权、调度、读回和停止入口，测试夹具另存应用侧事件用来独立核对结果。

  - **从无窗口开始**　关掉记事本与资源管理器测试窗，发送自然语言任务。Vykor 查找并启动记事本，填写多行、导航保存对话框、写入用户批准的测试文件，再经资源管理器打开确认。检查文件字节和应用内读回。
  - **复用和歧义**　启动一个计算器，给任务后准确复用。准备两个同应用的同名文档时，只对选中的文档观察和操作，选择前两个窗口均无更改。
  - **普通系统界面**　从没有设置窗口开始，打开 Windows 设置并导航到显示页面，读回实际缩放比例。在隔离测试账号中通过资源管理器改变已明确授权的普通视图设置，重开窗口核验并恢复初始状态。受保护的管理员或系统安全对话框让用户接管；无授权的修改没有派发。
  - **语义不足时继续**　用自有画布控件验证从结构化观察切到截图与受控前台操作。对话框覆盖、窗口移动、多屏缩放和焦点切换均要重新确认，快照过期零误操作。
  - **多应用与审批**　跨两个应用执行明确的任务，首次需要的新应用获得许可，已授权范围内日常步骤连续完成。对覆写、外部提交或前台接管拒绝确认时停止相应操作，保留前面已验证的结果。
  - **暂停、继续、停止**　在等待授权、已排队、键鼠在途和应用已收动作四种状态分别测试。暂停后用户可操作、显式继续读取新状态；Stop 后下一步零派发，原动作如继续则准确显示未知或事后读回的实际结果。

- [ ] 验收干净安装、应用升级、立即安装和随退出安装、回退和卸载。服务重启、资源损坏、用户数据目录切换及重新连接时，旧许可和引用不可恢复。保留功能开关，错窗、权限绕过或已停止后仍有新输入时可停用并回退。运行诊断只采集失败类别、是否核验、停止时延与孤儿进程情况。 [更新入口](../../../apps/desktop/src/main/features/updater/updater-service.ts) · [退出流程](../../../apps/desktop/src/main/application.ts)
- [x] 补 [电脑操作说明](../../computer-capabilities.md) 并更新 [文档索引](../../README.md) 与 [契约测试索引](../../contract-test-index.md)。按应用、控件和后台/前台路线说明已验证范围，说明遇到授权冲突、找不到应用、窗口不明确、需要接管或结果未知时用户会看到什么。
- [ ] **阶段通过条件**　完整操作路径和各临界场景都有安装制品的验收记录。窗口仍关闭的用户能够从一次自然语言任务开始，经必要授权走到已核验结果。用户可接管、继续和停止。已发布的能力和实际支持矩阵一致。

## 验收命令

Windows 真实窗口命令见 [阶段 1 实机验证](../../../apps/desktop/tests/computer-windows/README.md)。阶段 2 用本机桥和离线模型运行以下定向检查。签名安装包按阶段 6 单独验证。

```powershell
pnpm --filter @vykor/server exec vitest run src/http/__test__/computer-host.test.ts src/http/__test__/computer-run.integration.test.ts src/application/session/execution/__test__/run-admission-service.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/computer src/main/features/session/daemon-connection-service.test.ts
pnpm exec vitest run --config tests/desktop-integration/vitest.config.ts tests/desktop-integration/__test__/computer-bridge.test.ts
pnpm check:retired-ui
pnpm check-docs
```
