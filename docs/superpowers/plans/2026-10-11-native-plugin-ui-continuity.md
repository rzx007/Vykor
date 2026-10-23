# Native Plugin UI 固定位置、统一外观与会话交接实施计划

> 更新：2026-10-13。设计已独立复核，用户已授权实施，并要求更新插件制作 Skill。本计划取代此前兼容方案；不自动提交或 push。

**目标：** 每个 UI 组件固定内联或右侧面板，统一外观，提供经宿主确认的加入输入框/提交给助手；不读取或缓存插件表单。

**架构：** protocol 定义唯一现行契约；Native Plugin 加载组件；Desktop main 校验来源和挂载，renderer 组合外观与业务 snapshot；独立 Server 交接服务复用普通 Input/Run、事务和运行队列。

**技术栈：** TypeScript、React、Electron、MessagePort、现有 HTTP client、SQLite、Vitest。无新运行依赖、UI 框架或数据表。

**依据：** [设计](../specs/2026-10-11-native-plugin-ui-continuity-design.md) · [独立复核](../reviews/2026-10-11-native-plugin-ui-continuity-design-review.md)。

## 全局约束

- 每组件必填单值 surface；只接受 tool-result 或 session-sidebar。Native Plugin 根 manifest 不变。
- UI manifest、proposal、instance、action 关联及新 submission 记录使用 schemaVersion 2；网页 ready/init、request/response/notification 使用 version 2；daemon pluginUi 为 2。生命周期能力语义不变。
- 只有一个现行解析器。无旧格式、surfaces 别名、openSidebar、presentation 通道、字段补齐、自动转换或迁移。
- appearance / capabilities 必填进入网页 snapshot；HTTP 实例响应 conversation 必填，缺失报错。main 不读取 CSS，renderer 组合完整 snapshot。
- 原始工具结果先结束。CLI/TUI 不等待网页；错误保留文字，不自动删除历史。
- 固定位置；暂时隐藏当前 panel 保持 iframe/key；明确关闭和重载不保留本地输入。
- 同 owner 两帧、一个 panel；新打开占用/满额时拒绝，不替换、淘汰或顶掉其他实例的加载。
- 保留 sandbox、CSP、来源绑定、权限、摘要、代次、限流、单确认互斥和事务边界。
- 请求 64 KiB；交接 text 去除首尾空白后必须非空、最多 4096 Unicode 字符，data 有限 JSON / 32 KiB / 深度 20；确认 300 秒、确认类请求 330 秒。
- 不增加 LSP、marketplace、跨组件路由、插件 HTTP、新队列、Goal 自动运行或通用注册框架。
- 每个任务先失败测试、最小实现、同组验证、独立规格/质量审查；不重跑无关完整套件，不主动预览或截图。
- 当前基线 b913b542；已有样式/研究改动属于用户，保留它们。测试产物和报告按本计划保存，不清理别人的工作区。

## 文件职责与顺序

| 区域 | 负责 |
| --- | --- |
| protocol/plugin-ui、bridge；新 plugin-ui-appearance、plugin-ui-conversation | 单一类型、严格解析、字节限制、版本拒绝；不放业务规则 |
| plugins/components/ui-schema、ui、ui-sdk；新 ui-styles.css | Native 静态定义、文档读取、浏览器 SDK、可选基础样式 |
| Desktop shared/plugin-ui-types | main 业务 snapshot 和必填交接事实；内部类型不是第二条网页协议 |
| Desktop main/features/plugin-ui | owner/来源/挂载/容量/未决提交绑定，不拼模型输入 |
| renderer/conversation-page/plugin-ui | 固定位置、可见性、真实外观、确认和当前 composer 追加 |
| Server session-plugin-ui-service | 原实例/action；仅提取三个窄来源校验入口 |
| 新 session-plugin-ui-conversation-service | 最终普通文本、接收事务、回执查询/去重；不执行 Native Tool 或调用模型 |
| RunAdmission | 无插件知识的同步保存、普通用户输入优先、已有 Run 派发 |
| skills/create-plugin 与 text-inspector 两份样例 | 当前制作规则、离线 SDK/HTML、实际制作场景验证 |

任务 1 → 2；任务 3 可单独验证；任务 1+2+3 → 4 → 5 → 6。可以分任务实现和测试，但不发布混合协议版本；完成整合后一次切换 Desktop、daemon 和作者样例。

## 任务 1：唯一现行协议、Native 定义和浏览器 SDK

> 状态：已实现并通过定向复审。交接 data 限额与回执版本绑定的问题已补失败测试并修复；整套功能仍待后续接线。

**文件：**

- 修改 packages/protocol/src/plugin-ui.ts、plugin-ui.test.ts、plugin-ui-bridge.ts、plugin-ui-bridge.test.ts、index.ts。
- 新增 packages/protocol/src/plugin-ui-appearance.ts / .test.ts 和 plugin-ui-conversation.ts / .test.ts。
- 修改 packages/plugins/src/components/ui-schema.ts / .test.ts、ui.ts / .test.ts、ui-sdk.ts / .test.ts、package.json；新增 src/ui-styles.css。
- protocol 中旧 ManifestV1 类型和 schema 命名改为现行无版本后缀名称，不提供旧导出别名。

- [ ] 先写当前格式可读、旧版本/数组/缺字段不可读的失败测试。点名要捕获的破坏：旧记录被误接受、未知位置放行、必填 appearance/capabilities 被省略、未知方法执行。

```ts
const component = { id: "card", title: "结果", entry: "./ui/panel.html",
  surface: "session-sidebar", actions: [] };
expect(PluginUiManifestSchema.safeParse({ schemaVersion: 2, components: [component] }).success).toBe(true);
expect(PluginUiManifestSchema.safeParse({ schemaVersion: 1, components: [component] }).success).toBe(false);
expect(PluginUiManifestSchema.safeParse({ schemaVersion: 2, components: [{
  ...component, surface: undefined, surfaces: ["session-sidebar"],
}] }).success).toBe(false);
```

- [ ] 运行红测试，再统一版本和单值字段。proposal 仍只传 componentId/data，位置从当前定义取得；instance 与 action 关联严格现行格式；schemaVersion 不匹配拒绝，无宽读取、迁移或别名。
- [ ] 定义并导出 PluginUiAppearance、PluginUiConversationRequest/Prepared/Receipt、SubmitPluginUiConversationInput、PluginUiSubmissionRecord 及严格解析器。提交 record 使用 UI schemaVersion 2。ConversationRequest 的 mode/expectedRevision/text/data 与设计一致，submit HTTP input 只多宿主 requestId；prepared 为 mode/instanceId/revision/promptText。
- [ ] 网页 snapshot 保留业务字段，删除顶层 theme，增加必填 appearance/capabilities。九个颜色白名单值各最多 128 字符，fontFamily 最多 256 字符，fontSizePx 8–32 有限数字；拒绝额外 CSS、URL、规则片段。颜色应用时 CSS.supports 校验；不拼 cssText。
- [ ] SDK ready/init 与桥接统一 version 2。删除 openSidebar 方法/分支，未知方法直接失败。requestConversation 使用 330 秒时限；响应先分辨 conversation kind，再解析 action 回执或 snapshot，不接收任意对象。
- [ ] getSnapshot/onSnapshot 直接提供外观；同 revision 的外观与 capabilities 更新仍通知，不覆盖较新业务 revision。applyPluginUiAppearance 是独立导出函数，只设置白名单 --ohs-* 变量，不是 client 方法。无 presentation、opt-in、null fallback 或缺字段补齐。
- [ ] 基础样式采用宿主颜色、系统字体 fallback、focus-visible、reduced-motion 和克制间距；独立 HTML 内联，不导入宿主 CSS/字体/Node/网络。
- [ ] 验证；涉及 UI 格式的 fixture 改为现行契约。旧值仅留作拒绝测试，不保留旧 SDK bundle fixture。

```powershell
pnpm --filter @vykor/protocol exec vitest run src/plugin-ui.test.ts src/plugin-ui-bridge.test.ts src/plugin-ui-appearance.test.ts src/plugin-ui-conversation.test.ts
pnpm --filter @vykor/plugins exec vitest run src/components/ui-schema.test.ts src/components/ui.test.ts src/ui-sdk.test.ts
pnpm --filter @vykor/protocol check-types
pnpm --filter @vykor/plugins check-types
```



### 本任务精确契约补充

下列字段是现行设计的精确取值；不自行增加别名或第二套返回形状。

```ts
interface PluginUiAppearance {
  theme: "light" | "dark";
  colors: {
    background: string; foreground: string; muted: string;
    mutedForeground: string; primary: string; primaryForeground: string;
    accent: string; border: string; destructive: string;
  };
  fontFamily: string; fontSizePx: number; reducedMotion: boolean;
}
interface PluginUiConversationRequest {
  mode: "draft" | "submit"; expectedRevision: number;
  text: string; data: Record<string, JsonValue>;
}
interface PluginUiConversationPrepared {
  mode: "draft" | "submit"; instanceId: string; revision: number; promptText: string;
}
type SubmitPluginUiConversationInput =
  Omit<PluginUiConversationRequest, "mode"> & { requestId: string };
type PluginUiConversationReceipt =
  | { kind: "conversation"; mode: "draft"; instanceId: string; revision: number; added: true }
  | { kind: "conversation"; mode: "submit"; instanceId: string; revision: number;
      requestId: string; inputId: string; runId: string;
      status: "pending" | "running" | "completed" | "failed" | "interrupted" };
interface PluginUiSubmissionRecord {
  schemaVersion: 2; requestId: string; requestFingerprint: string;
  expectedRevision: number; inputId: string; runId: string;
  pluginDigest: string; componentDigest: string; acceptedAt: number;
}
```

- snapshot 的原 instanceId/revision/status/data/actions/readOnly/locale/surface/可选 activeAction/lastAction 字段继续表示相同业务含义；删除顶层 theme，增加必填 appearance 与 capabilities:{draft:boolean;submit:boolean}，严格拒绝未知字段。
- requestId / instanceId 复用现有 UUID 校验；revision 复用现有 Plugin UI revision 校验。inputId/runId 是非空字符串（正常输入/运行ID），不强迫改为新ID类型；三个摘要/指纹字段为64位十六进制；acceptedAt 是非负安全整数毫秒时间。所有未知字段拒绝，JSON深度/大小按本任务原限额。
- prepared.promptText 是服务器最终消息文本，不要求4096字符（它包含序列化data），但须受64KiB最终消息上限约束；request.text 的4096是 Unicode codepoint上限。
- applyPluginUiAppearance 是独立导出函数 value:PluginUiAppearance、root?:HTMLElement，默认 document.documentElement；不是 PluginUiClient 方法。使用 --ohs-* 白名单变量与随包可选css，变量名称保持辅助函数/css一致。
- 新结果解析先判断 kind:"conversation"，再处理原有业务 action 回执和 snapshot。这是同一现行协议里的业务分支，不是旧版本兼容。

## 任务 2：固定位置、挂载容量、可见性与真实外观

> 状态：2026-10-14 已实现并通过定向复审。“关闭重开后旧响应撤销新文档”的竞争已真实先红后绿修复；真实 Electron 验收仍在任务 6。

**文件：**

- Desktop shared/plugin-ui-types.ts；main/features/plugin-ui/plugin-ui-service.ts / .test.ts、document-store.ts / .test.ts。
- renderer/conversation-page/plugin-ui 的 provider、frame、bridge、card、fixtures 和对应测试；新 plugin-ui-appearance.ts / .test.ts、plugin-ui-continuity.test.tsx。
- layout/main-layout/utility-panel/utility-panel.tsx；新 plugin-ui-visibility.test.tsx。
- Server session-plugin-ui-service.ts 与 __test__/session-plugin-ui-service.test.ts、http/routes/system.ts；仅现行实例绑定和 pluginUi:2 能力。
- 为编译接线修改受本契约影响的 Core/Server/Desktop 测试 fixture，不碰 Native Plugin 根 schema 或其他业务版本。
- 必要现行类型接线：protocol 的 PluginUiInstanceResponse 增加必填 conversation 布尔事实；HTTP 实例 GET 在组合层明确提供 false/false，任务 4 接入真实能力。Desktop 严格检查，缺字段不补默认值。

- [ ] 写失败测试：卡片只给声明的位置；错位置拒绝；重复打开同一实例保留 key；工具完成不自动开 panel；关闭只卸载；隐藏后同一 iframe 表单保留。
- [ ] Server 在当前定义/instance/source/digest 上校验唯一 surface。main 在读取文档前严格要求 pluginUi:2 与既有生命周期能力；不匹配返回 plugin_ui_protocol_mismatch，不回落到部分 UI。
- [ ] shared HostState.snapshot 使用 Omit<PluginUiViewSnapshot,"appearance"|"capabilities">，HostState.conversation 必填；去掉顶层 surfaces。main 不读取 CSS，不硬编码主题。未装配交接服务明确提供两个 false，不省略字段；后续任务 4 在 HTTP 组合层接入真实能力。
- [ ] renderer appearance helper 从已应用 CSS/外观设置读取实际值；读取失败在 renderer 构造中性合法值。Frame 每次组合当前外观和可见性，发送完整 snapshot；主题/字号/reducedMotion 变化不递增业务 revision。
- [ ] renderer 和 document-store 取消替换/淘汰：同步检查同实例、panel 占用和两帧容量，失败只拒绝新请求。main opening 仅保留同实例过期检查，移除不同实例共用 panel slot 的覆盖；错误不改已有标签/焦点。不引入新协调器。
- [ ] 覆盖并发两个 panel、后一次加载失败但前一次可成功、第三帧并发只让剩余槽位成功、重复 mount 不拿新 URL、已挂载文档不被 revoke；重载先完成旧 mount 撤销。
- [ ] utility-panel 保持当前 panel 的稳定容器/key；切标签/折叠只改 visible，不调用 close；显式关闭插件标签、关闭其他标签涉及插件或强制失效才卸载。隐藏仍占一帧。
- [ ] hidden/display:none 或 inert 排除焦点；bridge mount 有效与可交互分开。隐藏取消未确认请求、拒绝新 action/dismiss/conversation，snapshot 与已接收回执继续。resize 保持 inline 限制；不存在 openSidebar 处理器。
- [ ] 关闭/重载明确说明输入不保留。强制撤销不等待网页；StrictMode 与迟到加载不产生第二有效 mount 或文档泄漏。保留 CSP/sandbox 与原文字结果。

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-plugin-ui-service.test.ts src/http/__test__/session-plugin-ui.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/plugin-ui/document-store.test.ts src/main/features/plugin-ui/plugin-ui-service.test.ts src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-bridge.test.ts src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-card.test.tsx src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-appearance.test.ts src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-continuity.test.tsx src/renderer/src/components/desktop/layout/main-layout/utility-panel/plugin-ui-visibility.test.tsx
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/desktop typecheck
```

## 任务 3：普通排队 Input/Run 保存与用户消息优先

> 状态：2026-10-14 已实现、70 项相关回归和类型检查通过、独立规格/质量审查通过。保存与派发分离，原 Goal 行为保留。

**文件：** Server application/session/run-admission-service.ts 和 __test__/run-admission-service.test.ts；原 Goal/Run 装配回归测试。

- [ ] 写失败测试：同步 persistQueuedPrompt(sessionId, input: AdmitPromptInput) 返回必有 Input/Run；拒绝 steer、无模型、未 ready、停止接收和保留 metadata；外层事务回滚同时回滚两行；保存不会 enqueue/publish。
- [ ] 从现有 persistGoalRun 抽取保存部分，复用附件/输入校验、trace 与 admitPromptWithRun。persistGoalRun 保持原入口与行为；共享保存方法不调整队列。

```ts
const saved = admission.persistQueuedPrompt(sessionId, {
  items: [{ type: "text", text: "用户确认的消息" }],
});
expect(saved.run.inputId).toBe(saved.input.id);
// 在真实外层 transaction 抛错后检查 Input/Run 均不存在。
```

- [ ] prioritizeUserInput(sessionId) 只提取普通消息准入中取消待运行 Goal continuation 的逻辑；原 admitPromptAndMaybeRun 在原位置调用。新 UI 接收在事务成功后、dispatch 前调用；重放不调用。不取消活动普通工具，不新增 bypass 参数。
- [ ] 运行普通输入/Goal/队列回归；抽取不扩大到所有 admission 模块。

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/run-admission-service.test.ts src/application/session/__test__/session-goal-service.test.ts src/application/session/__test__/session-goal-dispatch-events.test.ts src/application/session/__test__/session-run-assembly.test.ts
pnpm --filter @vykor/server check-types
```

## 任务 4：Server 交接与 client，原子接收和只读回执

> 状态：已实现并通过独立审查，原始正文 BOM 限额偏差已补定向失败测试修复。Server/Client 实际装配和原子回执已接通；桌面确认仍待任务 5。

**文件：**

- 新 Server application/session/session-plugin-ui-conversation-service.ts、__test__/session-plugin-ui-conversation.test.ts。
- 原 session-plugin-ui-service.ts / .test.ts，仅三个窄校验入口。
- 新 http/routes/session-plugin-ui-conversation.ts 与 http/__test__/session-plugin-ui-conversation.test.ts；原 session-plugin-ui.ts 在 GET 组合必填 conversation。
- daemon-application.ts、http/server.ts、http/routes/system.ts 仅装配/路由/能力。
- Core engine/tool-result-feedback.ts / .test.ts 保留字段过滤；client resources/plugin-ui-resource.ts / .test.ts 和包类型导出。
- Services conversations/conversation-transactions.ts、conversation-tree-operations.ts 及原 fork/replaceTranscript 测试：既有复制/导入已剔除 pluginUi/uiAction，补剔除新增 pluginUiSubmission，防止复制孤立宿主回执。只补字段保护，无存储重构或新表。

- [ ] 先测来源、限额、并发、回执冲突与原子回滚，使用真实 SQLite/SessionOperationRunner/来源 Part 和 Run，不调用真实模型网络。超大或未知字段拒绝；pluginUiSubmission 由宿主写，恶意原始输出不能成为受信 Part metadata。
- [ ] 原服务提取 readConversationSource、prepareConversationSource、assertConversationSourceCurrent。读真实来源；异步安装/授权/摘要检查后同步复查 revision、生命周期维护标记和代次；不允许写入/执行工具。
- [ ] draft 允许 open/resolved，不要求模型或 Native Host 成功启动；submit 仅 open 且模型配置有效，普通 Run 忙碌可排队。两者拒绝 dismissed、会话归档/关闭、active/unknown action。不能用 canInvoke/readOnly/assertActionState 替代交接校验。
- [ ] prepare 按真实插件/组件来源和固定顺序生成完整普通文本，区分用户说明与外部数据；不写数据库。submit 捕获参数与指纹，进入来源会话 operation lane；先重放同 ID/同指纹，异内容冲突。
- [ ] 同 SQLite 事务保存 Input、Run、sourcePart.metadata.pluginUiSubmission 及 resolved/revision+1；只写最新 Part，不放 await、网络、模型、enqueue/publish。

```ts
const accepted = store.transaction(() => {
  const latest = sourceGuard.assertConversationSourceCurrent(preparedSource);
  const saved = admission.persistQueuedPrompt(sessionId, {
    items: [{ type: "text", text: prepared.promptText }],
  });
  // 私有 writeSubmission 保存真实 ID/摘要及 resolved，保留其他最新 metadata。
  writeSubmission(latest, input, fingerprint, saved);
  return saved;
});
admission.prioritizeUserInput(sessionId);
admission.dispatchPersistedRun(accepted.run.id);
```

- [ ] priority/dispatch 失败标记同一个 Run failed，保留回执；不删除 Input 或自动再提交。启动恢复沿用 pending/running 中断，不自动派发未知状态。
- [ ] GET 回执核对真实 Part、Input/Run/session/run.inputId，后来禁用不抹去已接收事实；损坏回执报错不补写。只查事实，不 enqueue。
- [ ] 三条路由与 typed client：prepare、submissions、submissions/:requestId；保留编码路径与 signal，禁止未知 query/超大 body。HTTP GET conversation 必填严格布尔；未装配阶段显式 false，真实装配后计算事实。缺字段报错，不默认补齐，不增加能力路由，不让原实例服务反向依赖新服务。
- [ ] pluginUiConversation:1 仅完整装配后公布；基础 pluginUi:2。重放不取消 Goal；新接收执行已有用户优先。至少覆盖两客户端同 ID 一组 Input/Run、不同内容冲突、revision/代次竞态、事务失败、响应丢失、派发失败和重启中断。

```powershell
pnpm --filter @vykor/core exec vitest run src/engine/tool-result-feedback.test.ts
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-plugin-ui-conversation.test.ts src/application/session/__test__/session-plugin-ui-service.test.ts src/http/__test__/session-plugin-ui-conversation.test.ts src/http/__test__/session-plugin-ui.test.ts src/http/__test__/plugin-ui-privacy.test.ts src/application/recovery/startup-recovery-service.test.ts
pnpm --filter @vykor/client exec vitest run src/resources/plugin-ui-resource.test.ts
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
```

## 任务 5：Desktop 确认、加入输入框和提交结果

> 状态：已实现并通过定向复审。旧响应误删新请求记录的竞争已补真实回归并修复；指南、样例及最终整合验证仍待任务 6。

**文件：**

- Desktop shared/ipc-channels.ts、preload/desktop-api.ts / .test.ts。
- 新 main/features/plugin-ui/conversation-runtime.ts / .test.ts；原 service、ipc、live-revocation 与测试。
- 新 renderer/conversation-page/plugin-ui/use-plugin-ui-conversation.ts、plugin-ui-conversation.test.tsx；原 confirmation/provider/frame/bridge 与测试。conversation-page.tsx 只连接回调。
- 回归真实 composer-draft-state.test.ts。

- [ ] 写失败测试：owner/main-frame/mount/会话/连接/代次/可见性绑定不能绕过；330 秒确认类时限，单确认互斥；取消、隐藏、过期无输入。
- [ ] main prepareConversation({mountId,input})、submitConversation({mountId,requestId,input})、getConversationSubmission({requestId})。可信宿主生成稳定 requestId，网络前同步记录 owner/session/instance/连接/指纹；最多 16 个未决记录，不驱逐。GET 不要求网页 mount 存活，但窗口和来源会话/连接必须匹配。观察到匹配 sourcePart 接收事实或 owner/连接失效后释放。
- [ ] draft 采用 prepare 最终文本→宿主完整预览确认→再次 prepare 复查版本/授权/代次/文本一致→一次同步 store 更新。对最新 scope composer 文档追加 text，保留已有文字、skill/context 项和附件；确认重放当前窗口去重。不使用无作用域 CustomEvent 或 setDraftText 全覆盖。

```ts
const scope = sessionComposerScope(sourceSessionId);
const current = selectDraftDocument(store.getState(), scope);
store.getState().setComposerDraftDocument(scope, composerDocument([
  ...current.items, { type: "text", text: "\n\n" + prepared.promptText },
]));
```

- [ ] submit 保留 composer，本次只发送已确认插件文本，不 useGoal/steer；成功显示“已交给助手”，不是任务完成。snapshot.capabilities 由可信交接事实/服务/可见性计算，不用 action readOnly 一票否决。
- [ ] 响应未知只 GET 原 ID；没有回执提示尚未确认，不自动 POST。用户重新确认同内容且 mount 仍有效才可用原 ID 重试；撤销 mount 后仅查询，不补执行。失败/中断引导原会话重试。
- [ ] 测确认期间继续输入不丢文字/附件、resolved 可 draft 不可 submit、无模型可 draft、普通 Run 忙可 submit 但不可 action、active/unknown action 拒绝。只在匹配 version 2 中关闭业务能力，不接受旧 daemon。

```powershell
pnpm --filter @vykor/desktop exec vitest run src/main/features/plugin-ui/conversation-runtime.test.ts src/main/features/plugin-ui/plugin-ui-service.test.ts src/main/features/plugin-ui/ipc.test.ts src/main/features/plugin-ui/live-revocation.test.ts src/preload/desktop-api.test.ts src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-conversation.test.tsx src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-bridge.test.ts src/renderer/src/stores/desktop-session/composer-draft-state.test.ts
pnpm --filter @vykor/desktop typecheck
node apps/desktop/scripts/verify-workspace-boundaries.mjs
```

## 任务 6：插件制作 Skill、当前样例和最终验收

> 状态：实现与定向验收已落地。真实样例 Electron 场景通过，完整 Electron 场景仍超时；按用户预算要求取消独立作者 GREEN 重做及额外整分支审查，不宣称全量验收完成。见[实施复盘](../reviews/2026-10-14-native-plugin-ui-continuity-retrospective.md)。

**文件：**

- skills/create-plugin/SKILL.md、README.md、references/native-plugin.md、plugin-ui.md、verification.md 和 docs/native-plugin-authoring.md。
- 两份 examples/plugins/text-inspector 与 skills/create-plugin/assets/text-inspector 的 UI manifest、tools UI proposal、panel 源码/模板/HTML、SDK/stylesheet 和 build-ui.mjs。
- packages/skills/src/__test__/create-plugin-distribution.test.ts、Desktop text-inspector-example.test.ts；既有 Electron UI harness 的源码与断言。
- 完工验证/复盘记录、README 索引；旧完整规格仅加指向现行设计的提示，不改历史交付事实。

- [ ] Skill 编辑前用未更新 Skill 做独立作者任务基线：在临时目录制作一个固定 panel、读取选择并主动交给助手的 Native 插件，不安装/link、不调用网络。记录是否生成旧 surfaces/schema、openSidebar 或误把 UI action 当模型消息；这是本次指南更新的失败证据，不做源文本 grep 测试。
- [ ] 分发产物先写失败测试：复制到临时目录后只用 Node 构建、HTML 无外部资源且不超 2 MiB；manifest/proposal 使用现行 schema、SDK 与宿主真实通信成功、主题同 revision 更新不丢本地表单、关闭重开不恢复。
- [ ] 更新制作 Skill：按需引用现行 Native/UI/验证说明，UI 组件必须选一个 surface；讲清隐藏/关闭区别、author 管本地输入、requestAction 与 requestConversation 两条路径、无自动安装/外部执行。给出完整可运行 getSnapshot/onSnapshot/applyPluginUiAppearance/requestConversation 例子；禁止旧别名与绕过宿主协议。
- [ ] 样例固定 surface:"session-sidebar"，删除移动按钮。独立分离业务 revision 渲染与样式/能力更新；主动构造 text/data，draft/submit 按能力显示，保留原 preview Native Tool action。inline 用最小 harness fixture 覆盖，不增另一套业务 showcase。
- [ ] 现有仓库 build-ui 增加 --export-author-assets，机械生成 SDK IIFE(VykorPluginUi)/stylesheet 分发；不手改生成 SDK，两份 HTML 用各自脚本生成。分发目录只用 Node、不依赖 npm 发布或本仓库路径。
- [ ] 用新 Skill 重跑相同独立制作任务，加载并执行产物验证当前契约、实际工具/UI 行为和离线构建。未验证的宿主交互如实标注，不增加安装/发布权限。
- [ ] 扩展原 Electron harness：严格版本/位置/未知 openSidebar 拒绝、两帧容量竞争、隐藏稳定 iframe/input、关闭重置、确认取消和回执；保留无同源/无网络/无 Node/preload 的安全断言，不主动截图或样式预览。
- [ ] 复核相关类型与边界，记录命令、退出码、实际断言和修复；最终宽范围独立审查，有问题当场修复。用户查看样式，不宣称自动视觉验收。

```powershell
node examples/plugins/text-inspector/scripts/build-ui.mjs --export-author-assets
node skills/create-plugin/assets/text-inspector/scripts/build-ui.mjs
pnpm --filter @vykor/skills exec vitest run src/create-plugin-distribution.test.ts
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/plugin-ui/text-inspector-example.test.ts
pnpm --filter @vykor/desktop test:plugin-ui-electron
pnpm --filter @vykor/protocol check-types
pnpm --filter @vykor/plugins check-types
pnpm --filter @vykor/core check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
pnpm --filter @vykor/desktop typecheck
node apps/desktop/scripts/verify-workspace-boundaries.mjs
git diff --check
```

## 完工复盘检查

- 只接受当前 schema/envelope，没有兼容分支或字段别名。
- 没有草稿 getter/宿主表单缓存/跨位置移动/容量淘汰。
- 外观只在 renderer 组合，必填字段严格；同 revision 更新不清空编辑。
- 会话交接在小服务/hook 中；布局只接线，提交文本只有 Server 一处构造。
- 普通 Input/Run/回执/实例状态同事务保存；无 await/队列副作用在事务内。
- 超时/重启不自动 POST/派发；重放不再次调整 Goal；真实提交不发送已有 composer 草稿。
- 制作 Skill、两份样例、离线 SDK 和 HTML 一起更新，实际制作产物通过验证。
- 未动无关样式和研究文件，未自动提交/push，未伪报视觉或实现验收。
