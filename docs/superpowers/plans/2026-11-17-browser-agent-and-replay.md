# Vykor Agent 浏览器操作与可重跑流程实施计划

> 状态：提案，暂缓实施。需求与验收目标见 [Agent 浏览器操作与可重跑流程需求](../../browser-agent-requirements.md)。恢复实施时以已提交的浏览器代码为起点。

**目标**　让 Agent 在桌面浏览器完成多步网页任务并核验结果，用户能确认保存实际走通的步骤，换参数重跑并打开各次运行的截图。

**实现方式**　即时操作和重跑共用 `Browser`。`BrowserVerification` 从聊天里的真实调用生成流程并按步骤调用 `Browser`。现有工作流和附件服务存放结果，桌面卡片负责让用户查看与确认。

## 责任边界

| 位置 | 职责与数据 |
| --- | --- |
| `packages/server/src/application/browser-tools/browser-tool.ts`、`browser-host.ts`、`browser-bridge-protocol.ts` | 定义并校验浏览器动作、定位、前置位置和核验条件。通过原 Bridge 传输请求，使用现有权限入口，保存并返回截图附件引用。 |
| `apps/desktop/src/main/features/browser/browser-agent-service.ts`、`browser-page-inspection.ts` | 管理当前桌面页面。观察、定位、核对页面身份、执行动作、等待条件并捕获画面。桌面执行层决定是否找到了正确目标和匹配条件。 |
| `packages/server/src/application/browser-tools/browser-verification-tool.ts`、新增同目录 `browser-flow.ts` | 前者负责读取证据、预览、确认保存及顺序重跑。后者只校验流程定义和绑定参数。定义仍按项目写入当前流程目录。 |
| 会话记录、`WorkflowHost` 和附件服务 | 会话保留真实工具调用和预览。`WorkflowHost` 以现有 `browser-verification` 任务记录首跑或重跑。附件服务保管图片。工作流按发起聊天读取，流程定义在同一项目共享。 |
| `apps/desktop/src/renderer/src/components/desktop/tools/workflows/` | 用原有聊天草稿、折叠预览和工作流面板呈现消息。工作流继续读取任务进度、结果和截图附件。 |

前三个任务各自先更新对应测试，确认旧实现失败，再迭代至通过。任务内的命令用于这两个检查点。

## 任务 1 · 补齐 Browser 操作和核验

**修改**　上表中的 Browser 服务、动作定义和桥接校验。更新两处浏览器目录 README。复用 `browser-agent-service.test.ts`、桌面 `__test__/browser-bridge.test.ts` 以及服务端 `__test__/browser-tool.test.ts`。

- [ ] 添加测试并确认缺少新行为时失败。覆盖范围筛选后仍能找到排在第 80 个之后的控件、同名目标拒绝、输入后控件被替换、设置原生下拉项和复选状态、Enter 提交只发出一次、用户切换页面后拒绝下一步。
- [ ] 扩展观察及目标查找。返回控件的可用状态、选中值、可选项和命名区域，以及页面加载状态。瞬时 ID 继续用于即时操作，稳定定位使用 `{ role, name, within? }` 或 `{ testId, within? }`。`within` 是单层命名区域。先过滤候选再限制输出，截断显式返回。执行前及审批后重新核对目标唯一、可见且能执行指定动作。
- [ ] 观察结果带不透明的 `position`，由桌面用现有连接、窗口会话、标签页和页面身份核对。重跑每步携带上一结果的位置，预期导航完成后接收新位置。意外切页、换标签页或更换会话都让下一步停止。沿用现有桌面队列、导航保护及取消信号。
- [ ] 增加 `select_option`、`set_checked` 和 `press`。原生下拉以选项名称匹配并触发页面变更事件，复选框已达到指定状态时返回实际值。自定义下拉用点击、等待选项、再点击的普通操作组织。Enter 等可能提交的按键走现有确认，并使用同一个导航保护。
- [ ] 在原有等待逻辑上支持控件状态、区域文字、控件值及地址条件。动作可带 `verify`，含主条件 `result`、可选 `also`、`failureText` 和 `timeoutMs`。审批后、实际发出动作前读前态，动作只执行一次，随后等待条件。打开详情时可用本次解析出的链接地址验证落点。
- [ ] 为等待补测试并完成实现。独立 `wait_for` 可检查当前条件，原有 `afterClick` 文字和路径等待复用条件判断。`verify.result` 若已经成立，须实际观察到失效再成立。测试旧 `Maple` 结果一直存在、仅加载提示消失时仍为未验证。再覆盖 5 秒默认值、显式等待超时、失败提示、导航期间取消及未知结果。沿用单步时限上界和外层期限。
- [ ] 复用页面绘制后的截图。桌面在捕获前后核对位置及匹配条件，工具结果引用当次保存的附件。截图或附件保存失败时保留原核验结果及缺失说明。纯文本模型仍可留存附件，视觉观察仍按模型能力返回图片。

```powershell
pnpm --filter @vykor/server test src/application/browser-tools/__test__/browser-tool.test.ts src/http/__test__/browser-host.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/browser/browser-agent-service.test.ts src/main/features/browser/__test__/browser-bridge.test.ts
pnpm --filter @vykor/desktop typecheck:node
```

## 任务 2 · 从真实记录保存流程并换参重跑

**修改**　`packages/server/src/application/daemon-application.ts`。拟新增 `packages/server/src/application/browser-tools/` 下的 `browser-verification-tool.ts`、`browser-flow.ts` 和 `__test__/browser-verification-tool.test.ts`。复用 `ConversationRepository.listMessageParts`、`getInput` 及 `WorkflowHost.runPersistentWorkflow`。

- [ ] 重写原固定表单的流程测试。用实际 Browser 调用记录覆盖连续步骤提取、错误顺序或跨聊天来源拒绝、首跑归档去重、预览被改写或无用户确认时拒绝、换参后逐步定位、卡住时立即停止。验证归档期间没有再次调用网页动作，运行中取消会保留先前步骤。
- [ ] 在 Browser 结构化结果中用 `scope.runId` 和 `context.toolCallId` 给出调用引用，返回实际解析的稳定目标及核验结果。`preview` 只提交名称、`sourceRunId`、`startCallId`、`endCallId` 和参数绑定。从同一聊天读取连续的 Browser 调用，核对入口、状态、顺序和最后的验收结果。入口可以是成功打开或观察到的页面。观察提供地址及目标依据，可执行步骤取自动作和等待。区段内的失败或结果未知不能用于确认该段已验证。
- [ ] 定义项目流程数据。步骤保留可执行的定位方式、期望页面、动作、等待及核验条件。参数支持文本、选项和布尔值，使用 `{ param: "query" }` 引用。预览时将参数绑定还原成首跑实际值并核对，防止改变已验证行为。重跑前用本次值构造校验通过的 Browser 参数。敏感值、临时位置和控件 ID 不进入定义。
- [ ] 用现有工作流记录归档首跑。以源聊天、运行和调用区段作为去重依据，用可重复计算的 `runId` 在现有仓储中查找。归档任务只写已存在的步骤结果及截图附件引用。重复预览引用原首跑，归档失败时返回原因。
- [ ] 把标准化后的预览作为 `BrowserVerification` 工具结果写进已有聊天记录。`save` 只接收 `previewId`。通过 `scope.inputId` 读取当前真实用户输入，核对卡片生成的确认行 `保存浏览器流程（预览 ID <previewId>）`。再从同一聊天、同一项目的原预览读取内容，以该预览标识作为新流程 ID 保存。重复确认返回同一保存结果。
- [ ] `list` 只解析新格式，从当前项目返回流程标识、名称及参数定义，同名时由用户选择。`run` 使用 `{ flowId, params }`，校验项目和参数后，以现有单个工作流任务顺序调用 `Browser`。每步传递最新位置及定位条件，换参后的详情页按当次匹配链接和核验后的实际落点接续。
- [ ] 用 `reportProgress` 更新当前步，并把已确认步骤的证据写到进度元数据 `browserEvidence`，取消时由现有工作流收尾保留。结束后同一份证据作为任务 `result`。审批沿同一调用继续。人工操作、错误、超时、取消或结果未知使本次重跑止于对应步骤，任务尝试次数为一次。
- [ ] 验证重跑与归档各有独立记录。再从同项目另一聊天重跑，校验流程共享且运行、截图归属各自发起聊天。

```powershell
pnpm --filter @vykor/server test src/application/browser-tools/__test__/browser-verification-tool.test.ts src/application/workflow/__test__/workflow-host.test.ts
```

## 任务 3 · 接入现有聊天卡片和工作流面板

**修改**　`apps/desktop/src/renderer/src/components/desktop/tools/workflows/workflow-model.ts`、`apps/desktop/src/shared/workflow-projection.ts` 和 `packages/server/src/http/mappers/part-wire-view.ts`。在桌面工作流目录新增 `browser-verification-summary.tsx` 并更新 README。复用 `workflow-interactions.test.tsx`、`workflow-projection.test.ts` 和服务端 `part-wire-view.test.ts`。

- [ ] 测试多步骤预览、确认草稿、缺参提示、首跑入口、大段预览被简化后的展开、失败步骤及两个截图附件各自打开。确认测试能发现错误预览、错误运行或串图。
- [ ] 复用 beUI 折叠区、「动作 / 目标」行和默认收起的 Tool Result。预览显示「已验证 · 未保存」、参数及验收条件。准备保存写入引用 `previewId` 的明确确认文本，发送后由服务端处理。已保存和重跑的按钮继续走聊天草稿。
- [ ] 让简化的聊天结果保留 `previewId`、首跑 `jobId` 和标题。用现有 `useToolDetails` 读取当前聊天授权的原工具结果，加载或读取失败时给出状态。完整步骤与验收条件可读后启用「准备保存」。
- [ ] 预览和重跑分别用各自的 `jobId` 打开现有面板。首跑的来源定位识别预览工具调用。沿用任务详情的 `result` 展示步骤与证据，浏览器任务取消且没有 `result` 时投影 `browserEvidence`。沿用 `screenshotAssetId` 打开当前运行截图。
- [ ] 验证在同一聊天可以看到属于该聊天的多次运行。跨聊天时在发起对应运行的聊天打开记录。预览状态、未验证和截图缺失各有明确文案。

```powershell
pnpm --filter @vykor/server test src/http/mappers/__test__/part-wire-view.test.ts
pnpm --filter @vykor/desktop exec vitest run src/shared/workflow-projection.test.ts src/renderer/src/components/desktop/tools/workflows
pnpm --filter @vykor/desktop typecheck:web
```

## 任务 4 · 验收实际操作与回归

**修改**　复用 `apps/desktop/tests/browser-annotations-electron/main.ts`，在同目录添加流程与工作流面板的验收夹具。沿用原有批注场景，并加入新等待和重跑的回归场景。

- [ ] 本地 HTTP 工单页让筛选真实发出请求，延迟更新列表，点击后进入实际详情地址。列表重绘替换控件。服务端记收到的测试参数和次数，详情绘制后提供可在截图中校验的独立标记。
- [ ] 自动验证点击后等待、首跑归档、确认保存、换参重跑、工作流记录及图片查看器。沿用夹具里的 `validateToolInput`，让默认等待经过生产工具参数校验。验证超时、旧结果、错误提示和截图失败。截图失败用实际提交次数以及已匹配的核验结果检查，图片内容按各次运行分别核对。
- [ ] 从 Vykor 桌面聊天用纯文本模型执行 `Cedar / 进行中`，观察 Agent 如何定位、等列表并核验详情。用户确认保存。用 `Maple / 已完成` 重跑并打开两个结果的截图。支持图片的模型补测实际画面观察。记录模型类型、输入、请求次数、两个运行标识、核验结果和截图。
- [ ] 完整浏览器套件、前三个任务的检查和真实桌面验收均通过后，把已验证的产品行为写回 [桌面浏览器能力](../../browser-capabilities.md)，保存实际验收记录。

```powershell
pnpm --filter @vykor/desktop test:browser-annotations-electron
pnpm check-docs
pnpm check:retired-ui
```
