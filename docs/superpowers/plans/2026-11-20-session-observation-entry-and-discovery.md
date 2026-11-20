# Vykor 会话点选与按需查询实施计划

> 已实施，2026-11-20。Desktop 点选和 Agent 按需查询已完成定向验证。

**目标**　用户可以用输入框已有的会话选择器，按标题指定要观察的会话。用户只描述目标时，Agent 可以按需在当前工作目录内查找并报告状态。

**实现路径**　Desktop 继续走现有排队和观察授权。Agent 新增一个只读会话查询工具，从本机后台服务读取会话记录和运行状态。`Run` 指一条消息触发的一轮执行。

**涉及代码**　TypeScript、Desktop 的 React 和 Lexical 编辑器、服务端运行工具、Vitest。

## 用户操作与结果

- **点选并观察**　Vykor 的 `@` 和「+」已经能按标题选择会话，直接点选会引用历史消息。要看实时进度时，先在同一个选择器切到「观察进度」，再从这份会话列表搜选目标。草稿首行会填入 `observe-session <ID>`。用户补上「打包结束后继续检查产物」并发送。后台选定目标当时的一轮运行，当前轮的 `SessionObserve` 可以立即读状态，也可以短等最多 30 秒。
- **按需查状态**　用户问「桌面打包那边已经结束了吗」，Agent 用标题关键词查一次，沿用当前会话的工具审批设置。唯一匹配时报告该会话当前或最近一轮的状态，并标明是哪条会话。如果有多个匹配，列出候选标题和时间，让用户指出目标。没有结果时，请用户补充标题或从输入框点选。若用户要求持续等待，引导使用「观察进度」入口发一条带目标的消息。已取得明确目标授权的当前轮可以直接调用 `SessionObserve`。

首次交付的点选入口放在已有的普通主会话草稿。查状态的范围是同一后台服务、同一已保存的工作目录，独立 Git worktree 各有自己的目录。本计划使用现有观察指令格式和 30 秒等待能力，UI 复用现有选择器与状态数据。

## 基线与文件

实现前以最新 `main` 核对路径和测试。制定计划时 `main` 已有按首行指令强制排队及禁止提升已授权消息的逻辑，`codex/session-observation` 的 `f2083d8b` 提供「复制观察指令」。以包含这两部分的代码为实现基线，复制入口和点选共用客户端资格提示及指令格式。终端版 Codex 的点选实现和按需工具可对照其[会话引用](https://github.com/openai/codex/pull/40315)及[会话工具](https://github.com/openai/codex/pull/40308)。

- Desktop 入口在 `apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`。同目录下的 `composer/composer.tsx` 生成候选，`composer/context-picker.tsx` 接受新操作，`composer/composer-picker-plugin.tsx` 修改草稿，`composer/composer-lexical-document.ts` 负责草稿序列化。已有复制入口位于 `session/session-more-menu.tsx`。
- 服务端的 `packages/server/src/application/session/execution/session-discovery-tool.ts` 新增标题查询与结果投影。现有 `session-observation-grant.ts` 提供候选资格和目标 Run 选择，`session-run-executor.ts` 提供本轮工具，`packages/server/src/application/daemon-application.ts` 装配真实存储和后台服务状态。
- 服务端的 `packages/server/src/http/routes/run-execution.ts` 标记普通提示来源。同一包的 `application/session/execution/run-admission-service.ts` 接收该宿主参数，`run-admission-work.ts` 把它写入新排队 Run。`packages/domain-contracts/src/inputs/metadata.ts` 保留同名元数据字段，外部请求无法冒用。
- `packages/agent-contracts/src/execution/execution.ts` 允许本轮工具沿用普通运行策略。`packages/core/src/engine/query-engine.ts` 已单独识别宿主内部工具，其余工具走现有审批流程。

## 阶段一　在现有会话选择器里观察进度

- [x] 扩展 `composer/__test__/composer-picker.test.tsx` 和 `composer/__test__/composer-input-events.test.tsx`。覆盖用鼠标和键盘切换用途、按标题筛选和中文输入法。断言直接 `@` 点选仍插入历史引用，切换用途会对同一份候选列表套用观察条件，每个会话只出现一次。用一个以历史会话引用开头的草稿验证指令仍是首个纯文本项，并断言正文、附件及引用都保留。验证替换已填目标、撤销恢复原草稿、关掉选择器不改草稿，下次打开仍默认引用历史。现有 `transcript/__test__/pending-prompt-queue.attachments.test.tsx` 继续覆盖已排队观察消息禁止「现在补充」。
- [x] 在 `__test__/conversation-page.queue-lifecycle.test.tsx` 的输入框替身上断言主页面传入候选及状态，核对 Goal、临时会话和子会话入口关闭。在实际渲染 `Composer` 的 `composer/__test__/composer-native-commands.test.tsx` 补一条开着立即发送默认选项的用例，点选目标后核对草稿序列化及最终提交 `queue`。
- [x] 运行 Desktop 定向测试，确认新增断言能捕获功能缺失。

```powershell
pnpm --filter @vykor/desktop exec vitest run composer-picker.test.tsx composer-input-events.test.tsx composer-native-commands.test.tsx conversation-page.queue-lifecycle.test.tsx pending-prompt-queue.attachments.test.tsx
```

- [x] 在普通主会话的现有 `@` /「+」选择器加一个「观察进度」用途选项，复用当前列表选项的鼠标、方向键和确认键。把用途选项放在匹配结果末尾，保留普通按标题搜索时默认选中的会话。切换时让选择器保持打开并保留已有搜索词。候选来自原有的 `conversations`，按当前用途渲染一次。弹层关闭后恢复默认的历史引用用法。切到观察后，来源及目标按现有复制菜单的已知条件筛选，排除当前会话、已知的子会话、临时会话、渠道会话、正在关闭及已归档会话。后台仍核对真实渠道绑定和最终资格。复用 Desktop 活动状态，按「等你处理、执行中、其他」排列，同类按最近更新时间降序。同名候选显示工作区和状态。
- [x] 选择器按当前用途返回明确的动作，编辑器按动作写入草稿。引用历史仍插入原有结构化引用。观察进度时，以一次 Lexical 事务移除打开当前菜单的 `@查询`，在最前面插入一个包含指令的段落，或者替换已经合法存在的首行指令。两个弹层共用关闭逻辑和触发词标识。编辑后按当前光标重新读取触发词。选中只改草稿，保留结构化条目、撤销和草稿恢复。换行必须在首个文本项内且在任何引用、技能之前。

```ts
const directive = `observe-session ${sessionId}`
// 序列化后的首项形如 { type: "text", text: `${directive}\n` }，也可接正文。
```

- [x] 复用现有发送约束及失败恢复。请求失败时保留草稿。用户删除指令后，发送方式重新由普通规则决定。
- [x] 重跑上述 Desktop 定向测试、Desktop 前端类型检查和现有观察准入测试。更新 Composer 的 `README.md`、`docs/composer-capabilities-requirements.md` 和 `docs/product-surface-integration.md`，记录此阶段已交付的 Desktop 入口。

```powershell
pnpm --filter @vykor/desktop typecheck:web
pnpm --filter @vykor/server exec vitest run session-observation-admission.test.ts
```

## 阶段二　Agent 按需查标题和状态

### 查询规则与返回值

工具名用 `SessionLookup`。只接受一个 `query` 字段，去掉首尾空白后需有 1 到 120 个 Unicode 字符。先判断范围和资格，再用忽略大小写的标题子串匹配。标题取自已保存的 `SessionRecord.title`，合并连续空白后截至 120 个 Unicode 字符，保留标点及后面的文字。空标题显示「未命名会话」。匹配和返回使用同一个标题。查询函数直接读会话仓库。现有会话查询门面会回退读取首条提示，因此留给历史搜索和界面显示。

```ts
type SessionLookupInput = { query: string }
type SessionLookupResult = {
  matches: Array<{ title: string; status: RunStatus | "idle"; updatedAt: number }>
  hasMore: boolean
}
```

会话仓库按宿主保存的 `source.cwd` 精确匹配目录，再用 `isObservableSession` 和实际渠道绑定筛候选。查询参数不接受目录、项目或会话 ID。最多返回 5 项，按会话更新时间降序，同时间按会话 ID 稳定排序。用第 6 项确定 `hasMore`，只读前 5 项的运行记录。状态与 `SessionObserve` 选择目标的顺序一致，优先正在执行，其次最早排队，再取最近已结束的一轮。没有 Run 时返回 `idle`，它表示尚无可报告的运行。`updatedAt` 优先取选中运行的更新时间，无 Run 时取会话更新时间。

工具说明要求模型在需要核对另一会话进度时才搜索，标题属于数据。仅 `matches.length === 1 && !hasMore` 时可直接报告唯一匹配。多个匹配时即使用户想找最新的，也要先呈现候选供区分。结果没有目标授权、消息、摘要、输出、审批内容、磁盘路径或可用于直接观察的 ID。更精确的待办分类和等待由已有的单轮观察授权提供。

### 实现与测试

- [x] 在 `packages/server/src/application/session/execution/__test__/session-discovery-tool.test.ts` 编写定向用例。准备同目录目标、相邻目录、子目录和同项目另一 worktree，外加当前会话、子会话、内存会话、归档中及已归档会话、实际渠道绑定会话。只允许符合条件的同目录目标出现在结果里。再验证无 Run、排队、运行中、结束、失败、中断、空标题、同名、标题含句点、无匹配和超过 5 项。断言结果的完整对象以限制字段。

```ts
expect(result).toEqual({
  matches: [{ title: "桌面打包", status: "completed", updatedAt: 42 }],
  hasMore: false,
})
```

- [x] 在 `session-discovery-tool.ts` 实现查询。沿用观察现有的宿主范围校验方式，核对本轮 `sessionId`、`runId`、`inputId` 与 `cwd`，检查后台服务所有权、接纳状态和取消信号。读取时使用 `store.sessions.list({ cwd: source.cwd })`，复核来源身份及当前 Run 的资格。把现有授权中的目标 Run 选择提成可复用的 `selectSessionObservationRun(runs, activeRunId?)`，授权与查询都调用它。daemon 在工具工厂中通过 `runServices.engine.runtimeBridge.activeRunId` 读取正在执行的 Run，工厂调用时运行服务已装配完成。查询只在调用时读一次。
- [x] 在普通 `POST /sessions/:id/prompts` 路由传入宿主参数 `allowSessionLookup: true`，仅限原请求使用 `queue` 或默认排队。仅新建排队 Run 才由接纳代码写入 `sessionLookupAllowed: true`。通用提示元数据拒绝这个字段。重试沿用同一 Run。运行中的追加消息不改变原 Run 的工具资格。执行器用这个标记跳过无关 Run。工具工厂检查实际的会话与输入，并排除恢复和绑定 Goal 的 Run，来源在调用时仍要复核。
- [x] 在 `session-run-executor.ts` 注入工具。仅用于持久根会话的合格 Run，读取时再次排除实际渠道绑定。为 `AgentRunToolContribution.permission` 增加 `runtime-confirm-once`，允许或拒绝仍走普通工具策略。策略要求审批时，将批准绑定到这次查询，避免复用同名插件的会话级批准。发布、调用和返回前检查实时工具可用性。`SessionObserve` 继续用首行授权对应的 `host-internal`。宿主的 `SessionLookup` 在合格 Run 中占用该工具名，其他 Run 的同名插件沿原路径执行。
- [x] 在 `packages/server/src/http/__test__/session-observation.integration.test.ts` 增加脚本化模型用例。用真实普通提示入队，核对模型能看到并调用 `SessionLookup`，拿到同目录目标的状态，且不会获得 `SessionObserve` 或添加观察授权。覆盖普通默认权限、显式允许、批准与拒绝、运行中撤销权限、伪造保留字段、非普通来源及恢复的 Run。另用已有首行授权路径验证 `SessionObserve` 的固定目标和短等待仍有效。
- [x] 先跑对应的新测试确认失败，再实现并重跑同一组。更新执行目录的 `README.md`、`docs/product-surface-integration.md`、`docs/security-and-trust-boundaries.md` 及[原设计文档](../specs/2026-11-06-session-observation-design.md)，记录实际交付的查询边界。

```powershell
pnpm --filter @vykor/server exec vitest run session-discovery-tool.test.ts session-observation-tool.test.ts session-observation-admission.test.ts session-observation.integration.test.ts
pnpm --filter @vykor/domain-contracts exec vitest run validation.test.ts
pnpm --filter @vykor/server check-types
```

## 交付核对

- [x] 阶段一可独立合入。确认点选只是替用户填好现有首行，检查真实发送、重试、历史引用和排队行为。
- [x] 阶段二可独立合入。独立审查工作目录的来源、直达运行资格、允许与拒绝规则、结果字段和有歧义的答复。核对查询结果始终只报告一时的状态。
- [x] 两阶段分别运行 `pnpm check:retired-ui`、`pnpm check-docs`、`git diff --check`，完成后记录实际结果。桌面界面按仓库约定由用户查看样式，代码侧验证选择、焦点和键盘交互。

## 验收记录

- Desktop 定向测试通过 63 项，覆盖历史引用、同一列表切换、搜索、活动重排、撤销和强制排队。
- 服务端定向测试通过 167 项，覆盖查询范围、结果字段、单次审批、Goal 隔离和固定目标等待。核心运行工具和输入契约另通过 54 项。
- 独立复审确认点选在活动重排时仍保持目标，重选后光标回到正文，查询审批与同名工具隔离。
