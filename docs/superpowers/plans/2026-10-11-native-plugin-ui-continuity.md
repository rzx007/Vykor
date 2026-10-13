# Native Plugin UI 固定位置、统一外观与会话交接实施计划

> **状态：已失效，不得按本文件实施。** 2026-10-13 用户明确“不做兼容”，现行要求以[修订设计](../specs/2026-10-11-native-plugin-ui-continuity-design.md)为准。下面保留的是 2026-10-11 的历史计划，其中旧 SDK、旧宿主、旧数据读取、surfaces 数组和 presentation 通道不再是实施要求。无兼容设计的子代理复核连续两次因模型容量不足未完成；按“先复核设计，再写计划”的约定，复核完成后再整体重写本计划。此失效标记不是新实施计划，也不授权运行旧步骤。

> **面向 AI 代理的工作者：** 执行时使用适用的 `subagent-driven-development` 或 `executing-plans` 技能，逐任务实施并复核；复选框仅在有验证证据后勾选。本轮只编写计划，不代表获准实施、提交或 push。

**目标：** 在保留隔离 iframe 和 Native Plugin 管理方式的前提下，每个 UI 组件固定一个位置、统一外观，并支持用户明确把结果交给助手；不读取或缓存插件表单草稿。

**架构：** Desktop 管固定位置展示、可见性、外观和确认；main 管挂载所有权、容量与来源绑定；Server 的独立交接服务复用来源校验和普通 Input/Run 保存、运行队列。已提交数据仍放在来源 Part，未提交表单由插件自己维护，不进入宿主缓存或数据库。现有工具 action 不启动模型的语义保持不变。

**技术栈：** TypeScript、React、Electron、MessagePort、现有 Hono HTTP / typed client、SQLite、Vitest；不新增运行依赖或 UI 框架。

**依据：** [设计文档](../specs/2026-10-11-native-plugin-ui-continuity-design.md)与[子代理审查记录](../reviews/2026-10-11-native-plugin-ui-continuity-design-review.md)。设计已先审查修订，再编写本计划。

---

## 1. 交付顺序与工作边界

```text
任务 1：外观与向后兼容    任务 2：固定位置与隐藏保留
任务 3：普通排队输入保存 ──→ 任务 4：后台交接、路由与客户端
                       任务 1 + 2 + 4 ──→ 任务 5：Desktop 用户交接
                       任务 1–5 ──→ 任务 6：参考插件、作者指南与验收
```

任务 1、2 可先独立交付；任务 3 不带插件知识；任务 4 可以通过 HTTP 测试独立验证。任务 5 完整接通前，不对网页宣告交接可用。不要通过安装/转换器、新应用路由或新数据库表解决 UI 问题。

开始实施时先 `git status --short`，识别并保留已有文档或代码改动。检查当前 HEAD 与 `feb050a3` 的差异；若下面列出的接口已经变动，先校准任务文件，不覆盖他人工作。按仓库约定决定是否需要隔离工作区；不要仅为执行文档检查创建 worktree。

每个任务遵循：先写本任务的失败测试→运行确认失败→最小实现→运行同一组测试→检查差异。检查点形成可单独审查的变更；本计划不自动授权 Git 提交或推送。

## 2. 文件职责与禁止扩散

| 文件/目录 | 职责 |
| --- | --- |
| 新 `packages/protocol/src/plugin-ui-presentation.ts` | 外观、交接能力提示、限额与严格解析，不含表单状态 |
| 新 `packages/protocol/src/plugin-ui-conversation.ts` | 交接请求、准备文本、回执、宿主提交记录的严格类型 |
| 现有 `packages/protocol/src/plugin-ui-bridge.ts` | 引用新类型并增加有限方法/通知，不放业务规则 |
| 现有 `packages/plugins/src/ui-sdk.ts`；新 `ui-styles.css` | 浏览器 API、白名单外观应用、可内联的轻量样式 |
| 现有 `packages/plugins/src/components/ui-schema.ts`、`ui.ts` | 每组件单位置定义校验与可修复诊断 |
| Desktop renderer `conversation-page/plugin-ui/` 的两个新文件 | `plugin-ui-appearance.ts` 读外观；`use-plugin-ui-conversation.ts` 接确认与输入框；不新增表单缓存模块 |
| Desktop main `features/plugin-ui/` | 原服务保持挂载检查，新增聚焦的 `conversation-runtime.ts` 保存未决来源绑定与只读查询 |
| 新 `packages/server/src/application/session/session-plugin-ui-conversation-service.ts` | 构造普通文本、接收事务、回执去重和故障收口 |
| 原 `session-plugin-ui-service.ts` | 原实例/action；只增加三个窄来源检查入口 |
| 原 `run-admission-service.ts` | 普通排队输入保存与用户消息优先；不知道插件、组件或 iframe |
| 新 `packages/server/src/http/routes/session-plugin-ui-conversation.ts` | 三条路由的解析/调用/错误映射，不重写原 UI 路由 |
| 原 `daemon-application.ts`、`http/server.ts` | 只装配对象、挂路由和能力标记 |
| 原 `conversation-page.tsx`、`utility-panel.tsx` | 只连接回调、可见性和展示，不拼提示词或管理提交事务 |

不引入通用 registry、策略插件、事件总线、另一套状态管理、新 SDK 包或 React 插件组件库。新 UI 复用已有 Button、AlertDialog、toast；本计划没有需要另选组件的交互。

## 3. 任务 1：可选 presentation 与统一外观

**修改/创建：**

- 创建 `packages/protocol/src/plugin-ui-presentation.ts`、`plugin-ui-presentation.test.ts`。
- 修改 `packages/protocol/src/plugin-ui-bridge.ts`、`plugin-ui-bridge.test.ts`、`index.ts`。
- 修改 `packages/plugins/src/ui-sdk.ts`、`ui-sdk.test.ts`、`package.json`；创建 `src/ui-styles.css` 和 `src/test-helpers/legacy-ui-sdk.js`。
- 创建 `apps/desktop/src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-appearance.ts` 及同名 `.test.ts`。
- 修改同目录 `plugin-ui-bridge.ts`、`plugin-ui-bridge.test.ts`、`plugin-ui-frame.tsx`、`plugin-ui-card.tsx`、`plugin-ui-card.test.tsx`。

**交付：** 新插件可主动获取宿主外观；旧插件的 snapshot/ready/init 完全不变，原始文字不丢失。

- [ ] **1. 先固定兼容基线并添加失败测试。** 将当前 `skills/create-plugin/assets/text-inspector/ui/sdk.js` 的旧浏览器 bundle 固定为测试 fixture，不从修改后的 SDK 生成它。测试旧 SDK 连接新 host 时只收到旧 snapshot，未 opt-in 不收到新通知。新 SDK 遇到 `plugin_ui_method_not_supported` 时 presentation 为 null，遇到超时或畸形响应时仍报错。

- [ ] **2. 定义外观契约并测试严格解析。** 使用设计中的 `PluginUiPresentation`；颜色九个白名单字段，每值最多 128 个字符，fontFamily 最多 256 个字符，字号有限数且在 8–32 px 内。拒绝额外字段、非有限数字、URL/规则片段；颜色应用前用浏览器 CSS 值检查，不把字符串拼进样式表。交接能力初始均为 false，不包含任何表单状态字段。getPresentation 的协议参数严格为 `{}`。

```ts
// packages/protocol/src/plugin-ui-presentation.test.ts
const appearance = {
  theme: "light" as const,
  colors: { background: "#fff", foreground: "#222", muted: "#eee",
    mutedForeground: "#666", primary: "#111", primaryForeground: "#fff",
    accent: "#eee", border: "#ddd", destructive: "#c00" },
  fontFamily: '"Segoe UI", sans-serif', fontSizePx: 13, reducedMotion: false,
};
it("rejects unrestricted CSS properties", () => {
  expect(() => parsePluginUiPresentation({ kind: "presentation", appearance: {
    ...appearance, backgroundImage: "url(https://example.invalid/a)" },
    capabilities: { draft: false, submit: false },
  })).toThrow();
});
```

- [ ] **3. 运行红测试，再最小接通。** 新 SDK 增加 getPresentation/onPresentation/applyPluginUiAppearance。host 仅在成功 getPresentation 后推送 presentation；response parser 先识别新的 kind 分支，再识别旧 action receipt/snapshot。SDK 逐项 `style.setProperty`，不使用 cssText。样式使用 `--ohs-*`、克制间距、系统字体 fallback、focus-visible 和 reduced-motion，不导入宿主 CSS 或字体资源。

- [ ] **4. 接入实际外观更新与文字降级。** appearance 文件从已应用颜色与外观设置读取实际值；主题、字号、减少动态效果变化推送一次新 presentation，不递增业务 revision。宿主标题保留，原始结果只在 UI 可用时默认折叠；不可用/加载失败仍直接可见。不修改 `DESIGN.md` 的风格规则。

- [ ] **5. 运行并检查结果。**

```powershell
pnpm --filter @vykor/protocol exec vitest run src/plugin-ui-presentation.test.ts src/plugin-ui-bridge.test.ts
pnpm --filter @vykor/plugins exec vitest run src/ui-sdk.test.ts
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-appearance.test.ts src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-bridge.test.ts src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-card.test.tsx
pnpm --filter @vykor/plugins check-types
pnpm --filter @vykor/desktop typecheck:web
```

预期：新增与基线兼容测试通过；导出 stylesheet 的包路径可解析；没有 Node/网络依赖进入浏览器 SDK。检查时不启动样式预览或截图。

## 4. 任务 2：每组件固定位置、容量拒绝与侧栏可见性

**修改/创建：**

- 修改 `packages/protocol/src/plugin-ui.test.ts`，证明历史实例解析不变；组件定义单项约束由已有 Native manifest 校验执行，不改变公开数组字段。桥接继续接受旧 openSidebar 消息，SDK 公共方法移除它：修改 `packages/plugins/src/ui-sdk.ts`、`ui-sdk.test.ts`。
- 修改 `packages/plugins/src/components/ui-schema.ts`、`ui-schema.test.ts`、`ui.ts`、`ui.test.ts`。
- 创建 `apps/desktop/src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-continuity.test.tsx`。
- 修改同目录 `plugin-ui-provider.tsx`、`plugin-ui-frame.tsx`、`plugin-ui-bridge.ts`、`plugin-ui-card.tsx` 及现有测试。
- 修改 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx`；创建同目录 `plugin-ui-visibility.test.tsx`。
- 修改 `apps/desktop/src/main/features/plugin-ui/document-store.ts`、`document-store.test.ts`、`plugin-ui-service.ts`、`plugin-ui-service.test.ts`。
- 修改 `packages/server/src/application/session/session-plugin-ui-service.ts`、`__test__/session-plugin-ui-service.test.ts`，核验当前定义与实例的唯一位置一致。

**交付：** 同一组件只能在声明的位置打开；暂时隐藏当前侧栏不卸载；占用/满额不挤掉旧界面。关闭只卸载，重载或重新打开从 snapshot 初始化，不恢复本地表单。

- [ ] **1. 先写单位置定义与旧历史读取的失败测试。** 单项 inline、单项 sidebar 合法；零项、双项、重复或未知位置无效；同插件两个不同组件可以分别选择两种位置。loadNativeUiMetadata 的错误包含具体组件/manifest 位置与“每个 UI 组件请选择一种展示位置”，不静默取第一项，也不阻止其他合法技能/工具加载。历史实例数组保持现有读取规则，但旧双位置定义不可挂载，修改位置造成的 componentDigest 变化不可重新绑定旧实例。

```ts
// packages/plugins/src/components/ui-schema.test.ts：使用该文件现有 component fixture。
it("requires exactly one surface per component", () => {
  const manifest = { schemaVersion: 1, components: [component] };
  expect(PluginUiManifestV1Schema.safeParse(manifest).success).toBe(true);
  expect(PluginUiManifestV1Schema.safeParse({ ...manifest, components: [{
    ...component, surfaces: ["tool-result", "session-sidebar"],
  }] }).success).toBe(false);
});
```

运行该组红测试后，将 ui-schema 的 surfaces 收紧为 `.length(1, "每个 UI 组件请选择一种展示位置")`；协议中的定义与实例仍使用现有数组字段，readPluginUiInstance 保持原历史读取形状，不另建类型转换。不要批量改写旧 Part 或摘要。Server availability 校验当前定义、实例位置与摘要，main 挂载再次拒绝非单项或错误位置。

- [ ] **2. 先测并收紧宿主入口与旧 SDK 消息。** 卡片只按唯一声明提供“展开界面”或“打开面板”，无移动按钮；工具结果到达不自动开面板。重复打开同一实例显示/聚焦同一 key；错误位置不改变布局。新 SDK 移除 openSidebar 公共方法；旧端口消息只允许可见、有效、固定为 sidebar 的挂载聚焦自身，inline 返回 plugin_ui_surface_not_supported。拆开现有 renderer bridge 将 resize/openSidebar 合并为 inline 限制的判断；resize 仍仅用于 inline，不放宽其他方法。

- [ ] **3. 先测容量与并发，再取消隐式淘汰。** renderer 打开另一 sidebar 或第三个界面时提示先关闭，不改变原 displays、活动标签和焦点。main 的 document-store.register 在任何写入/撤销前同步检查同实例占用、sidebar 占用、两帧容量；失败返回 plugin_ui_capacity_reached，不删旧文档。main mount 的 opening 身份仅保留同实例过期加载检查，删除不同实例共用 sidebar slot 的后一次覆盖规则，不另建协调框架。

覆盖已打开侧栏、第三帧、并发两个侧栏、后一次加载失败但前一次仍可成功、第三帧并发到达只有空余槽位成功，以及原文档 onRevoke 未被触发。同实例重开由 renderer 复用；直接重复 mount 不可获得新文档 URL 或挤掉旧文档。明确关闭只撤销旧挂载；显式 reload 必须先完成旧挂载撤销再创建，旧异步加载/迟到端口不能覆盖重载结果。

- [ ] **4. 只保留当前 sidebar 的挂载。** utility-panel 将该 Frame 放到稳定容器，切标签/折叠只改变 visible；删除折叠后 close 和面板折叠按钮中的插件 close。只有明确关闭插件标签、重载或强制失效才拆卸，关闭其他标签涉及插件时沿用明确关闭语义。保留原两帧预算，隐藏仍占一帧，不是第三种 surface。关闭/重载入口说明未提交输入不会保留，折叠按钮与关闭标签有不同的可访问名称。

- [ ] **5. 将挂载有效与可交互分开。** Frame 接收 `visible`；hidden/display:none 或 inert 排除隐藏容器的键盘和辅助技术焦点。bridge 的 isActive 仍指来源端口有效；可交互检查控制 requestAction/dismiss、旧 openSidebar 和任务 5 的交接。隐藏时取消待确认请求、提交前再次检查可见性，但不丢 snapshot/既有回执，也不取消已接收 Run。不要把 busy 状态顺带改成可调用工具。

- [ ] **6. 验证本地状态与撤销边界。** 用简单 iframe 表单验证暂时隐藏/展开保持同一挂载与输入；明确关闭后没有挂载，重开或重载产生新本地状态但后台 snapshot 不变。dismiss、禁用/卸载/权限撤回、摘要变化、会话切换、连接重建直接撤销，无网页回调等待。revision 更新通过原 snapshot 订阅，由插件处理表单，不自动读取/合并。React StrictMode 重放不能生成第二个有效 mount 或遗留占容量的文档。

```powershell
pnpm --filter @vykor/protocol exec vitest run src/plugin-ui.test.ts src/plugin-ui-bridge.test.ts
pnpm --filter @vykor/plugins exec vitest run src/components/ui-schema.test.ts src/components/ui.test.ts src/ui-sdk.test.ts
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-plugin-ui-service.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/plugin-ui/document-store.test.ts src/main/features/plugin-ui/plugin-ui-service.test.ts src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-continuity.test.tsx src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-bridge.test.ts src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-card.test.tsx src/renderer/src/components/desktop/layout/main-layout/utility-panel/plugin-ui-visibility.test.tsx
pnpm --filter @vykor/protocol check-types
pnpm --filter @vykor/plugins check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/desktop typecheck:node
pnpm --filter @vykor/desktop typecheck:web
```

预期：单位置定义与精确挂载校验生效；容量竞争不损坏其他显示/加载；同一 sidebar 隐藏重现不新建 iframe；关闭/重载不读取或恢复表单。当前双位置测试 fixture 分别改为 inline / sidebar；仅明确测试旧历史读取和无效定义时保留双项，不自动迁移。

## 5. 任务 3：抽取普通排队输入保存，保留现有运行规则

**修改：**

- `packages/server/src/application/session/run-admission-service.ts`。
- `packages/server/src/application/session/__test__/run-admission-service.test.ts`。
- 回归已有 `session-goal-service.test.ts`、`session-goal-dispatch-events.test.ts`、`session-run-assembly.test.ts`。

**交付：** 一个可放进外层事务、只保存 Input/Run 的小入口；无插件依赖、不派发、不发布事件。

- [ ] **1. 为新方法写失败测试。** 定义 `persistQueuedPrompt(sessionId, input: AdmitPromptInput)` 返回必有 input/run 的对象。拒绝 steer、未 ready、停止接收、无模型和保留 metadata；通过正常附件/输入校验保存 queue Input + Run。测试不会调用 enqueue 或 publish；外层事务回滚时两行都消失。不要增加绕过 assertPromptMetadataAllowed 的布尔开关。

```ts
// 在已有 createMockOptions fixture 中增加这一例。
it("persists without dispatching", () => {
  const fixture = createMockOptions();
  const admission = new RunAdmissionService(fixture.options);
  const result = admission.persistQueuedPrompt("s1", {
    id: "accepted-input", items: [{ type: "text", text: "用户确认的消息" }],
  });
  expect(result.run.inputId).toBe(result.input.id);
  expect(fixture.options.runtimeQueue.enqueueRun).not.toHaveBeenCalled();
});
```

- [ ] **2. 运行红测试，抽取而非重写。** 从 persistGoalRun 提取保存部分，共享现有 normalizePromptAttachments、traceId 和 admitPromptWithRun。persistGoalRun 保留 Goal 特定入口、错误文案与现有调用点；普通 helper 使用“请先配置模型”这样的中性错误。

- [ ] **3. 抽取用户消息优先的窄方法。** `prioritizeUserInput(sessionId)` 承接当前普通准入里取消活动 Goal 的待运行 continuation 的逻辑；原 admitPromptAndMaybeRun 在原位置调用，保持原顺序。任务 4 在接收事务成功之后、dispatchPersistedRun 之前调用它，不能只派发而漏掉优先规则。不要取消正在执行的普通工具；已有 prepareRunExecution/Goal 绑定不变。

- [ ] **4. 验证正常、Goal 和副作用边界。**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/run-admission-service.test.ts src/application/session/__test__/session-goal-service.test.ts src/application/session/__test__/session-goal-dispatch-events.test.ts src/application/session/__test__/session-run-assembly.test.ts
pnpm --filter @vykor/server check-types
```

预期：原消息、重放、Goal 保存/派发行为不变，新 helper 可参与原子事务。若抽取必须改其他运行模块，先说明不可避免的原因，不借此重构全部 admission。

## 6. 任务 4：后台交接、原子接收与只读回执

**修改/创建：**

- 创建 `packages/protocol/src/plugin-ui-conversation.ts`、`plugin-ui-conversation.test.ts`；修改 `plugin-ui.ts` 中的响应类型和 `index.ts`，不改变严格实例记录。
- 修改 `packages/core/src/engine/tool-result-feedback.ts`、`tool-result-feedback.test.ts`。
- 创建 `packages/server/src/application/session/session-plugin-ui-conversation-service.ts`、`__test__/session-plugin-ui-conversation.test.ts`。
- 修改 `packages/server/src/application/session/session-plugin-ui-service.ts`、`__test__/session-plugin-ui-service.test.ts`。
- 创建 `packages/server/src/http/routes/session-plugin-ui-conversation.ts`、`http/__test__/session-plugin-ui-conversation.test.ts`；原 `session-plugin-ui.ts` 仅在实例 GET 组合可选能力字段。
- 修改 `packages/server/src/application/daemon-application.ts`、`http/server.ts`、`http/routes/system.ts`。
- 修改 `packages/client/src/resources/plugin-ui-resource.ts`、`plugin-ui-resource.test.ts`，按现有方式从包入口导出类型。

**交付：** 用户交接有真实来源证明，一次接收只产生一组 Input/Run；无挂载的后台只读查询仍能返回已接收事实。

- [ ] **1. 补齐协议与失败测试。** 定义并导出以下小类型：

```ts
interface PluginUiConversationRequest {
  mode: "draft" | "submit"; expectedRevision: number;
  text: string; data: Record<string, JsonValue>;
}
interface PluginUiConversationPrepared {
  mode: "draft" | "submit"; instanceId: string; revision: number; promptText: string;
}
type SubmitPluginUiConversationInput =
  Omit<PluginUiConversationRequest, "mode"> & { requestId: string };
// PluginUiConversationReceipt 与设计第 8 节一致；不添加额外 UI 状态字段。
```

parser 拒绝目标会话/模型/权限/metadata 等未知字段；text 非空且最多 4,096 个 Unicode 字符，data 有限 JSON/32 KiB/20 层，请求总量 64 KiB。`PluginUiSubmissionRecord` 按设计列出的字段严格解析，并验证 ID、revision 与摘要。将 pluginUiSubmission 加入 Core reserved 过滤，确认恶意输出无法伪造受信 Part 回执。

- [ ] **2. 实现三个窄来源校验入口。** readConversationSource 验证真实来源、返回当前 session/part/instance；prepareConversationSource 捕获代次、执行既有安装/授权/摘要检查，按 mode 分别判断；assertConversationSourceCurrent 在异步结束后同步复查代次、维护标记、实际 Part 和 revision。不要调用 assertActionState 来判断交接，也不要调用 withPluginUiLifecycleMutation 来接收普通消息。

draft 允许 open/resolved、无模型和 Native Host 未准备成功；两种 mode 都拒绝 dismissed、归档/关闭、进行中/unknown action。submit 还需模型已配置，模型可用性复用装配时的 AgentPool 配置事实及 persistQueuedPrompt 最终检查，而非把 canInvoke 当作模型判断。实例来源/摘要核验仍是后台事实。

- [ ] **3. 使用真实 SQLite harness 写接收测试。** 复用现有 UI action 测试的真实 source Part/Run 创建方式，但不让测试调用真实模型网络。至少覆盖：两个并发同 ID 同参数→相同 receipt、一组 Input/Run；同 ID 不同参数冲突；不同 ID 对已提交实例拒绝；revision 过期；等待 resolveCurrent 期间禁用/代次更新；事务写 Part 失败全回滚；prepare 不写数据库；查询不会 enqueue。

```ts
// 新测试文件中定义 createConversationHarness，使用真实 SessionStore、
// SessionOperationRunner 和新服务；h.request 是经过协议校验的固定请求。
it("admits one input/run under concurrent replay", async () => {
  const h = await createConversationHarness();
  try {
    const [a, b] = await Promise.all([
      h.service.submit(h.sessionId, h.instanceId, h.request),
      h.service.submit(h.sessionId, h.instanceId, h.request),
    ]);
    expect(a).toEqual(b);
    expect(h.store.conversations.listInputs(h.sessionId)).toHaveLength(1);
    expect(h.store.runs.listRuns(h.sessionId).filter(run => run.inputId)).toHaveLength(1);
  } finally { h.close(); }
});
```

- [ ] **4. 最小实现事务流程。** 新服务只注入 store、transaction、source 校验、operations、admission 和模型配置事实。prepare 按真实插件/组件信息、固定字段顺序生成最终普通文本，区分用户说明与外部数据。submit 捕获深拷贝与指纹，进入同会话 operation lane；先重放已接收回执，再校验新接收。

同步事务内再次读取来源，调用 persistQueuedPrompt 保存普通 text Input/Run，更新最新 Part 的 pluginUiSubmission 与 pluginUi resolved/revision+1。没有 await、网络、模型调用、事件发布或 enqueue 放进事务。

```ts
// 新服务的流程骨架；所有写入使用同一个 SessionStore 的事务。
const accepted = store.transaction(() => {
  const latest = sourceGuard.assertConversationSourceCurrent(preparedSource);
  const admitted = admission.persistQueuedPrompt(sessionId, {
    items: [{ type: "text", text: prepared.promptText }],
  });
  // 写 latest.part：保留其最新其他 metadata，保存真实 Input/Run ID，
  // 将 instance 置 resolved、revision+1；不可写到旧的缓存 Part。
  writeSubmission(latest, input, fingerprint, admitted);
  return admitted;
});
admission.prioritizeUserInput(sessionId);
admission.dispatchPersistedRun(accepted.run.id);
```

writeSubmission 是该服务的私有函数，按设计的 host record 写 Part；不导出可供插件调用的写接口。priority 或 dispatch 失败时，将同一 Run 标记 failed 并保留已接收 receipt，禁止再次创建输入；事件由现有 operation runner 的 publishSince 边界发布。

- [ ] **5. 补齐故障与恢复测试。** 读回执验证真实来源、Input/Run 与 session 一致、run.inputId 匹配；后来禁用插件不影响既有接收事实查询。无效/损坏回执返回错误，不进行补写。提交后派发失败仍只有一个已接收 Run；模拟提交后重启调用既有启动恢复，pending/running 中断，查询不重新派发。普通 Run 忙碌时 queue、不 steer；活动 Goal 的待运行 continuation 被既有规则取消；未接收时不得取消 Goal。

- [ ] **6. 路由、client 与能力装配。** 新路由分别提供 prepare、submissions、submissions/:requestId；禁止未知 query，拒绝超大 body，错误使用现有 application/protocol 映射。typed client 增加 prepareConversation/submitConversation/getConversationSubmission 三个方法，保持编码路径与 signal。服务完整装配后才发布 pluginUiConversation:1；旧 pluginUi:1 含义不变。

原实例 GET 的 HTTP 组合层接收交接服务的窄能力计算方法，在响应增加可选 conversation:{draft,submit}。它使用这次已经校验的 instance/availability 和模型配置事实，不重复校验文件，不发占位 prepare 请求，不增加能力路由。测试旧 client/旧 main 忽略字段，原严格 snapshot 不变；新 main 验证两个布尔值，缺失时默认 false；提示可用不替代 POST 的最终校验。原实例服务不反向依赖新服务。

- [ ] **7. 验证后台交付。**

```powershell
pnpm --filter @vykor/protocol exec vitest run src/plugin-ui-conversation.test.ts
pnpm --filter @vykor/core exec vitest run src/engine/tool-result-feedback.test.ts
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-plugin-ui-conversation.test.ts src/application/session/__test__/session-plugin-ui-service.test.ts src/http/__test__/session-plugin-ui-conversation.test.ts src/http/__test__/session-plugin-ui.test.ts src/http/__test__/plugin-ui-privacy.test.ts src/application/recovery/startup-recovery-service.test.ts
pnpm --filter @vykor/client exec vitest run src/resources/plugin-ui-resource.test.ts
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
```

预期：事务、来源、并发、故障和能力降级用例通过；UI action 仍不产生模型输入，不增加数据库迁移。

## 7. 任务 5：Desktop 确认、加入聊天输入框与提交结果

**修改/创建：**

- 修改 `packages/protocol/src/plugin-ui-bridge.ts`、`plugin-ui-bridge.test.ts`；修改 `packages/plugins/src/ui-sdk.ts`、`ui-sdk.test.ts`。
- 修改 `apps/desktop/src/shared/plugin-ui-types.ts`、`shared/ipc-channels.ts`、`preload/desktop-api.ts`、`preload/desktop-api.test.ts`。
- 创建 `apps/desktop/src/main/features/plugin-ui/conversation-runtime.ts` 及同名 `.test.ts`；修改 `plugin-ui-service.ts`、`plugin-ui-service.test.ts`、`ipc.ts`、`ipc.test.ts`、`live-revocation.test.ts`。
- 创建 `apps/desktop/src/renderer/src/components/desktop/conversation-page/plugin-ui/use-plugin-ui-conversation.ts`、`plugin-ui-conversation.test.tsx`。
- 修改同目录 `plugin-ui-confirmation.tsx`、`plugin-ui-provider.tsx`、`plugin-ui-frame.tsx`、`plugin-ui-bridge.ts` 及对应测试；`conversation-page.tsx` 只接入回调。
- 回归真实 composer 的 `apps/desktop/src/renderer/src/stores/desktop-session/composer-draft-state.test.ts`。

**交付：** 用户明确预览并确认；追加不覆盖已有输入；真实提交响应未知时只查原请求，撤销 HTML 不挡查询事实。

- [ ] **1. 先写来源与确认失败测试。** 新 main 方法为 prepareConversation({mountId,input})、submitConversation({mountId,requestId,input})、getConversationSubmission({requestId})。后者从 conversation-runtime 的已记录 owner/session/instance/连接绑定得到目标，不接受 iframe 任意目标，也不要求 getMount 成功。记录在网络请求前同步建立，最多 16 个未决请求，source Part 出现匹配事实后释放；窗口/连接失效清理。

测试错误 owner/子 frame、过期 mount、会话切换、连接切换均不能提交；提交成功但响应丢失、随即禁用插件后，原宿主仍能只读查到回执；GET 不派发或重新加载 HTML。IPC 延续 main-frame 校验，不向 iframe 暴露 preload。

- [ ] **2. 实现 bridge 与 SDK 联合回执。** 新 requestConversation 与设计一致；单确认互斥覆盖 action/dismiss/draft/submit，使用 330 秒请求限额。receipt 的 kind/mode/instance/revision 严格验证；新增 kind 分支不可误入旧 actionReceipt 解析。presentation 的 draft/submit 按真实交接可用性、daemon 能力和当前可见性判断，不使用旧 readOnly 一票否决。

- [ ] **3. 加入输入框采用 prepare→确认→复查。** 聚焦 hook 调 main.prepare 获取最终 promptText，使用原确认组件显示来源、目标会话和完整内容。用户确认后再次 prepare，核对同一 revision、连接/代次与完全相同文本。然后对最新 store 做一次同步作用域检查、确认去重和文档追加，保留附件及非文本项；不能发无作用域 CustomEvent，不能用 setComposerDraftText 替换文档。

```ts
// 同步追加的核心规则；实际 hook 在操作前验证当前 session/代次/revision。
const scope = sessionComposerScope(sourceSessionId);
const current = selectDraftDocument(store.getState(), scope);
store.getState().setComposerDraftDocument(scope, composerDocument([
  ...current.items, { type: "text", text: "\n\n" + prepared.promptText },
]));
```

测试用真实 composer store：确认期间用户继续输入，最后两份内容都存在；skill/context 项和附件不变；用户取消、来源 revision 改变、代次改变、隐藏、超时都不追加；同确认回放只追加一次。draft 不调用 sendMessage/startSession/submitGoal。

- [ ] **4. 真实 submit 仅发原请求。** 宿主在确认流程开始生成 requestId，冻结本次参数，确认后复查可见性与来源，交 main 提交。正常显示普通 Input/Run；实例 resolved 显示“已交给助手”，不要把接收回执描述成任务完成。保留 composer 原草稿和附件，submit 只发送本次确认的插件文本。

网络超时只调用 getConversationSubmission(originalRequestId)，不再次 POST。没有回执时保留原请求，提示未确认提交；只有用户重新确认同一内容且当前 mount 仍有效，才能用同一 ID 再试。主线程已撤销 mount 时仅允许查询，不补执行。已接收 Run 失败/中断时引导既有会话重试，不把旧插件实例重新打开为可提交。

- [ ] **5. 验证不混用权限和目标。** 已 resolved 实例可以 draft、不能 submit；无模型可以 draft；普通 Run 忙碌时可以 submit 排队，但仍不能 requestAction；active/unknown action 两种交接都拒绝。旧 daemon 没有新 feature 时插件正常查看、原 action 可用，交接能力为 false。确认预览和最终存储文本必须相同。

```powershell
pnpm --filter @vykor/protocol exec vitest run src/plugin-ui-bridge.test.ts src/plugin-ui-conversation.test.ts
pnpm --filter @vykor/plugins exec vitest run src/ui-sdk.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/plugin-ui/conversation-runtime.test.ts src/main/features/plugin-ui/plugin-ui-service.test.ts src/main/features/plugin-ui/ipc.test.ts src/main/features/plugin-ui/live-revocation.test.ts src/preload/desktop-api.test.ts src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-conversation.test.tsx src/renderer/src/components/desktop/conversation-page/plugin-ui/plugin-ui-bridge.test.ts src/renderer/src/stores/desktop-session/composer-draft-state.test.ts
pnpm --filter @vykor/desktop typecheck
node apps/desktop/scripts/verify-workspace-boundaries.mjs
```

预期：来源、确认、预填、去重、超时查询和降级测试通过；renderer 不导入 server/runtime；主布局文件只增加必要接线。

## 8. 任务 6：正式参考插件、作者指南与端到端验收

**修改/创建：**

- `examples/plugins/text-inspector/ui/panel.mjs`、`panel.template.html`、`panel.html`、`scripts/build-ui.mjs`。
- `examples/plugins/text-inspector/ui/manifest.json`、`skills/create-plugin/assets/text-inspector/ui/manifest.json` 固定为 sidebar。
- `skills/create-plugin/assets/text-inspector/ui/panel.mjs`、`panel.template.html`、`panel.html`、`sdk.js`；新增同目录 `ui-styles.css` 并修改 `scripts/build-ui.mjs`。
- `skills/create-plugin/references/plugin-ui.md`、`skills/create-plugin/README.md`、`docs/native-plugin-authoring.md`；只扩充插件作者 API，不改变 Skill 的使用权限。
- `docs/superpowers/specs/2026-10-02-native-plugin-ui-design.md` 增加本轮增量设计链接，不重写历史交付事实。
- `packages/skills/src/create-plugin-distribution.test.ts`、Desktop `plugin-ui/text-inspector-example.test.ts`。
- `apps/desktop/tests/plugin-ui-electron/ui-host.tsx`、`reference-ui-check.ts`、`desktop-ui-check.ts` 与 `native-ui-check.ts` 中相应断言。
- 新建 `docs/superpowers/reviews/2026-10-11-native-plugin-ui-continuity-verification.md`，记录实际执行证据；更新 `docs/README.md` 实现状态。

**交付：** 一份能展示三项能力的现有参考插件，独立复制后仍只需 Node 构建；验收记录如实区分实现、自动验证和用户样式反馈。

- [ ] **1. 先加参考插件失败测试。** 参考组件固定为 sidebar，工具结果只给打开入口，无移动按钮；标签暂时隐藏后勾选/说明保留，明确关闭重开或重载不恢复本地输入；revision 更新由插件 snapshot 处理。使用 presentation 外观，无重复大标题。新按钮分别调用 draft/submit，不把加入输入框当发送；不支持时隐藏按钮，普通工具结果保留。inline 的单位置覆盖使用现有 harness 的最小组件 fixture，不新增业务插件。

- [ ] **2. 更新同一参考插件，不复制新应用。** 两份 manifest 将 surfaces 改为单项 session-sidebar，删除 openSidebar 按钮与调用。选择/筛选/说明由页面自己的变量维护，不提供草稿 getter 或宿主恢复 API；requestConversation 在用户操作时主动构造 text/data。先 getPresentation 再订阅并应用外观；snapshot revision 更新时按参考插件逻辑清理旧选择。移除硬编码主题颜色，内联可选样式文件。保留原 preview Native Tool 的独立 action，不把它改成请求模型。

- [ ] **3. 机械生成分发产物。** 给仓库例子的现有 build-ui.mjs 增加显式 `--export-author-assets` 参数：额外将 ui-sdk.ts 构建为浏览器 IIFE（global 名为 VykorPluginUi），将 ui-styles.css 复制到分发目录。不再创建另一套 SDK 构建系统，不手改构建后的 sdk.js。两份 panel.html 都由各自 build-ui.mjs 生成。仓库例子用已有 Vite 构建，分发例子内联 bundled SDK 与 stylesheet、只用 Node。测试复制到临时目录后 Node-only 构建，无网络、无本仓库路径、无外部 script/style/font 资源，HTML 不超过 2 MiB。

- [ ] **4. 写清作者责任与限制。** 作者指南给出单项 surfaces、创建 client/getPresentation/onPresentation/requestConversation 的完整示例；说明每组件只选一个位置、插件可包含不同位置的独立组件、不支持组件间跳转；隐藏保留而关闭/重载丢弃本地输入；无草稿回调、宿主缓存或自动保存，不保存凭据。主动交接只传本次用户选择；确认不代表工具授权或任务完成；每实例一次 submit；旧宿主降级；转换插件不作为另一类 UI 管理。历史完整规格加本轮增量设计链接，保留既有交付事实，不把旧规则写成仍推荐的作者契约。

- [ ] **5. 扩展既有 Electron 行为用例。** 在原 harness 中分别验证固定 inline / sidebar 的真实挂载、错误位置拒绝、旧 openSidebar 窄处理、面板隐藏后同一 iframe 的输入保留、明确关闭后不恢复、容量竞争不淘汰、隐藏期间不弹确认、提交取消与回执路径；保留原 CSP/无网络/无同源/无 preload/无 Node 用例。无需真实模型 API、市场账户、样式预览或截图系统。新增 mock 只替换模型网络和业务插件结果，不能绕过真实 bridge、main IPC、HTML 文档策略。

- [ ] **6. 最终验证与复盘。**

```powershell
node examples/plugins/text-inspector/scripts/build-ui.mjs --export-author-assets
node skills/create-plugin/assets/text-inspector/scripts/build-ui.mjs
pnpm --filter @vykor/skills exec vitest run src/create-plugin-distribution.test.ts
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/plugin-ui/text-inspector-example.test.ts
pnpm --filter @vykor/desktop test:plugin-ui-electron
pnpm --filter @vykor/protocol check-types
pnpm --filter @vykor/plugins check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
pnpm --filter @vykor/desktop typecheck
node apps/desktop/scripts/verify-workspace-boundaries.mjs
git diff --check
```

最终只重跑涉及到的测试组；中间任务已经验证且文件未再变的测试不重复跑完整套件。验证记录列命令、退出码、实际断言、发现的问题与修复；明确“样式等待用户查看”，不因自动化通过宣称视觉已验收。记录完成后再进行实现审查，不自动提交或 push。

## 9. 设计覆盖与停止扩散检查

| 设计要求 | 实施任务 |
| --- | --- |
| 外观白名单、轻量样式、原始文字降级、旧 SDK 兼容 | 1、6 |
| 每组件固定一个位置，旧历史可读但不可绕过当前定义，移除移动 API/入口 | 2、6 |
| 占用/容量/并发只拒绝新开，不替换、淘汰或顶掉其他加载 | 2、6 |
| 暂时隐藏保留挂载与输入，关闭/重载重置，焦点与交互限制 | 2、6 |
| 普通输入保存、队列、用户优先与 Goal 回归 | 3、4 |
| 真实来源、授权、摘要、维护竞态、原子性、回执去重与故障恢复 | 4 |
| 明确确认、最新 composer 追加、已有附件保护、无作用域事件禁用 | 5 |
| 撤销 mount 后查事实，确认/连接过期，旧 daemon 降级 | 4、5 |
| 作者分发、真实 Electron 隔离、人工样式验收边界 | 6 |

完工复盘必须回答：有没有让同一组件声明两个位置或保留动态移动入口；有没有读取/缓存插件表单或承诺关闭后恢复；有没有让新打开挤掉旧界面或顶掉其他加载；有没有把会话逻辑放进 Frame/布局大文件；有没有两个地方拼同一提交文本；有没有用 action readOnly 判断交接；有没有在保存事务里 await；有没有在超时/重启后自动 POST；有没有为了兼容新能力放宽旧协议解析。任一答案为“有”，先修复再宣称本阶段完成。
