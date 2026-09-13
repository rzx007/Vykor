# 插件能力召唤与运行实现计划

> **面向 AI 代理的工作者：** 使用 executing-plans 按任务实现；只有用户明确要求子代理时才使用 subagent-driven-development。步骤使用复选框跟踪进度。

**目标：** 为 Desktop `@/+` 增加插件引用，让每个 Run 使用插件当前有效能力生成冻结的内存 `RunCapabilityView`，并闭合 Skill、MCP、Native Tool、Plugin Agent、Child 和 Goal 运行边界。

**架构：** Input 只持久化 pluginId；executor 在 Run 开始时读取插件当前状态并构建内存 View。Runtime 继续复用会话级 MCP 连接、Tool Host 和 Agent 定义，core 只消费通用可见性集合；工具执行前再次检查 owner 和 View。

**技术栈：** TypeScript、React、Lexical、Vitest、现有 Session Application、Plugin、Agent Runtime 和 Tool Registry。

---

依据：[插件能力召唤与运行设计](../../plugin-capability-invocation-design.md)、[Skill Prompt Flow](../../skill-prompt-flow.md)。不新增持久 snapshot/resolution 表，不保存 schema digest，不承诺插件代码精确重放，不提供旧协议兼容。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `packages/agent-runtime/src/plugin-capability-inventory.ts` | 当前 Runtime 的插件及 Skill/MCP/Tool/Agent 所有权目录 |
| `packages/protocol/src/session-input-items.ts` | PluginCapabilityRef、PluginAgentRef 和输入校验 |
| `packages/server/src/application/session/session-plugin-capability-service.ts` | admission 校验单 pluginId、强制 queue、推导插件 Skill/Agent owner |
| `packages/agent-runtime/src/run-capability-view.ts` | Run 开始时从当前 Runtime 生成冻结 View |
| `packages/core/src/types/runtime.ts`、`engine/query-engine.ts` | 通用按 Run 工具可见性和调用前 guard |
| `packages/server/src/application/session/session-run-executor.ts` | 取得暖 Runtime、解析 pluginId、注入 View 后提交 Agent |
| `packages/server/src/application/session/session-input-materializer.ts` | 插件 Skill 和 Plugin Agent 加载要求 |
| `packages/agent-runtime/src/child-agent-options.ts` | Child View 与父 View 取交集 |
| `packages/server/src/application/session/session-goal-service.ts` | Goal revision 和续跑 Run 传播 pluginId |
| `apps/desktop/.../composer/` | 插件 Picker、富文本引用和历史恢复 |

## 任务 1：插件所有权目录和唯一 winner

**文件：**

- 创建 `packages/agent-runtime/src/plugin-capability-inventory.ts`
- 创建 `packages/agent-runtime/src/plugin-capability-inventory.test.ts`
- 修改 `packages/agent-runtime/src/extensions.ts`、`extensions.test.ts`、`index.ts`

- [ ] 写失败测试：discovery 为当前有效安装生成 pluginId、版本、scope、origin、Skill/MCP/Native Tool/Agent 有效名称、唯一 MCP server identity 和 tool → plugin/server owner 映射。
- [ ] 写失败测试：managed/user 同 ID 按现有安装优先级只能产生一个 winner；无法判定或组件裸名称冲突时插件不进入可选择目录并产生诊断。
- [ ] 运行 `pnpm --dir packages/agent-runtime test src/plugin-capability-inventory.test.ts`，确认因模块缺失失败。
- [ ] 实现 inventory。允许 linked plugin；inventory 反映 Runtime 创建时读取的当前内容，不持久化历史 schema。
- [ ] MCP 注册来源不能只保存裸 server name；Native Tool 和 Agent Definition 同样携带 owner pluginId，展示名不作为身份。
- [ ] 运行新增测试、`extensions.test.ts` 和 agent-runtime 类型检查。
- [ ] 提交 `feat: track plugin capability ownership`。

## 任务 2：结构化输入和 admission

**文件：**

- 修改 `packages/protocol/src/session-input-items.ts`、`session-input-items.test.ts`
- 创建 `packages/server/src/application/session/session-plugin-capability-service.ts`
- 创建 `packages/server/src/application/session/__test__/session-plugin-capability-service.test.ts`
- 修改 `packages/server/src/application/session/session-application-service.ts`
- 修改 `packages/server/src/application/session/session-run-engine.ts`
- 修改 `packages/server/src/application/daemon-application.ts`

- [ ] 写协议失败测试并增加：

```ts
type PluginCapabilityRef = {
  type: "capability"
  kind: "plugin"
  pluginId: string
  displayName: string
}

type PluginAgentRef = {
  type: "capability"
  kind: "plugin_agent"
  pluginId: string
  agentId: string
  displayName: string
}
```

- [ ] 写 admission 失败测试：篡改 displayName 不影响身份；未知、禁用和冲突 pluginId 被拒绝；不创建 Input/Run。
- [ ] 写组合测试：同一插件的 @、Skill、Agent 引用合并；不同 pluginId 明确拒绝并保留草稿。
- [ ] 写 steer 测试：含 capability item 的输入返回 `session_capability_requires_queued_run`，活动 Run 不接收它。
- [ ] 实现 admission：只校验当前 inventory 并把 pluginId 写入 Input/Run metadata；不创建新表、不连接 MCP、不启动插件代码。
- [ ] 验证 requestId 只保证 admission 幂等并复用原 Input/Run；已开始 Run 不透明整轮重放，恢复操作创建新 Run。
- [ ] 运行 protocol、session application、run engine 和 HTTP route 相关测试。
- [ ] 提交 `feat: admit queued plugin capability inputs`。

## 任务 3：冻结的内存 RunCapabilityView

**文件：**

- 创建 `packages/agent-runtime/src/run-capability-view.ts`、`run-capability-view.test.ts`
- 修改 `packages/core/src/types/runtime.ts`、`types/tools.ts`
- 修改 `packages/core/src/engine/query-engine.ts`
- 修改 `packages/agent-runtime/src/agent.ts`、`framework-agent-run.ts`
- 修改 `packages/server/src/application/session/session-run-executor.ts`

- [ ] 写失败测试验证公式：

```text
当前 Run 可见能力
= 已通过 settings/host ceiling/deny/environment 的非插件基线
+ 当前 pluginId 拥有的插件能力
```

- [ ] 普通 Run → 插件 Run → 普通 Run，断言最后一个 Run 不泄漏插件 Tool、Skill 或 Agent；两个并发 View 互不污染。
- [ ] 活动 Run 创建 View 后修改插件目录或全局 Registry，断言 Tool、Skill 和 Agent 继续使用捕获的 binding。插件管理失效并重建 Runtime 后，新 Run 使用新版本；linked 外部修改在显式重载、应用重启或新会话后生效。
- [ ] 实现通用 View：

```ts
type RunCapabilityView = {
  pluginId?: string
  tools: ReadonlyMap<string, RunToolBinding>
  skills: ReadonlyMap<string, RunSkillBinding>
  mcpServers: ReadonlyMap<string, RunMcpServerBinding>
  agents: ReadonlyMap<string, RunAgentBinding>
}
```

- [ ] View 保存完整有效能力集合。非插件基线 binding 的 ownerPluginId 为空；插件 binding 保存 ownerPluginId。Tool 保存 definition、server identity 和 invoke target，Skill 保存路径/definition，Agent 保存完整 definition。View 使用只读 Map 和冻结副本。
- [ ] QueryEngine 工具列表和真正执行入口都从 View binding 取对象；Skill 加载和 Child 创建也不能按名称回查全局 Registry。core 只认通用 binding，不解析 PluginCapabilityRef。
- [ ] View 不能修改全局 Registry，也不靠 Run 结束时 unregister 恢复。
- [ ] Executor 在 durable Run 已存在后取得会话暖 Runtime，按 pluginId 从已加载组件创建 View 并传给 `agent.submitMessage()`。
- [ ] 运行 core、agent-runtime、executor 测试和类型检查。
- [ ] 提交 `feat: scope plugin capabilities to each run`。

## 任务 4：Skill、MCP 和 Native Tool 闭环

**文件：**

- 修改 `packages/server/src/application/session/session-input-materializer.ts` 及测试
- 修改 `packages/tools/src/meta/skill.ts` 及测试
- 修改 `packages/agent-runtime/src/default-runtime.ts`、`runtime-integrations.ts`
- 修改 `packages/agent-runtime/src/native-tools/activate.ts`
- 修改 `docs/skill-prompt-flow.md`

- [ ] 写失败测试：普通 Run 的系统提示只列非插件 Skill；`@插件` Run 列该插件 Skill；完整正文只通过 Skill tool result 返回。
- [ ] `$插件Skill` 在 admission 阶段从 owner 推导 pluginId，启用所属插件当前全部有效能力；不同插件组合被任务 2 拒绝。
- [ ] Skill Tool call 重新检查 name/path winner、owner pluginId 和当前 View；Run 中途不能切换另一个插件。
- [ ] MCP/Native Tool schema 只通过模型 tools 字段提供，不拼入用户文本；运行前按 owner pluginId 过滤。MCP Tool 同时记录唯一 server identity，不能只依赖裸 server name。
- [ ] MCP 重连或插件管理触发 Runtime 重建后，后续 Run 使用新 binding；活动 Run 从 View 读取捕获的 Tool definition、owner、server identity 和 invoke target，不按名称回查新 Registry。
- [ ] 高风险 Tool 继续走现有权限链；插件 Tool 不能标记 host-internal。
- [ ] 运行 materializer、Skill、MCP、Native Tool、默认 Runtime 和 test:pack。
- [ ] 提交 `feat: bind plugin skills and tools to run views`。

## 任务 5：Plugin Agent 和 Child 交集

**文件：**

- 修改 `packages/server/src/application/session/session-input-materializer.ts`
- 修改 `packages/tools/src/agent/agent-tools.ts` 及测试
- 修改 `packages/core/src/types/runtime.ts` 的 Child 输入
- 修改 `packages/agent-runtime/src/child-agent-options.ts` 及测试
- 修改 `packages/server/src/application/agent/daemon-agent-event-projector.ts` 及测试

- [ ] 写端到端失败测试：PluginAgentRef → root Input/Run → materializer → root Agent Tool → Child Run → child result → root final。
- [ ] 用户单选 PluginAgentRef 时从 owner 推导 pluginId；root 只能看到当前 View 的 Agent 名称和描述，Agent 正文只进入 Child System Prompt。
- [ ] Child View 为父 View 与 Agent Definition tools/requiredMcpServers 的交集；requiredMcpServers 先解析为唯一 server identity，再限制对应 Tool，依赖超出父范围时拒绝。
- [ ] Child 改 cwd 后重新 discovery 不能扩大 View；附件不自动传播。
- [ ] Child 创建/执行失败写 Child Run，失败 Tool result 返回 root，由 root 收束最终回复。
- [ ] 运行 Agent Tool、child options、child lifecycle 和 projector 测试。
- [ ] 提交 `feat: constrain plugin agents to parent run views`。

## 任务 6：Goal pluginId 传播

**文件：**

- 修改 `packages/protocol/src/session-goals.ts`
- 修改 `packages/services/src/session-runtime/store.ts` 和当前 Goal schema/migration
- 修改 `packages/server/src/application/session/session-goal-service.ts` 及测试
- 修改 `packages/server/src/application/session/session-run-engine.ts` 及测试

- [ ] 写失败测试：Goal revision 保存 pluginId；initial/edit/resume/continuation Run 都携带同一 pluginId。
- [ ] 每个自动 Run 开始时从当时的会话 Runtime 生成新 View；插件管理更新并失效 Runtime 后，下一轮使用重建后的已批准能力。
- [ ] 新权限未批准、插件禁用、删除或冲突时 Goal 进入 paused 并说明原因；不自动改用另一个 pluginId。
- [ ] 编辑目标只有用户提交新的插件引用时才更换 pluginId；普通 resume 不扩大能力。
- [ ] 无插件 Goal 路径保持不变；取消和完成仍保留原 Input/Run 审计记录。
- [ ] 运行 Goal service、run engine、services 和 server 类型检查。
- [ ] 提交 `feat: carry plugin selection across goal runs`。

## 任务 7：Desktop `@/+` 插件选择和恢复

**文件：**

- 创建 `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/plugin-mention-node.tsx`
- 修改同目录 `context-picker.tsx`、`composer.tsx`、`composer-picker-plugin.tsx`、`composer-lexical-document.ts`、`composer-clipboard-plugin.tsx`、`rich-prompt-input.tsx`
- 修改 `apps/desktop/src/renderer/src/stores/desktop-session/composer-document.ts`
- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`
- 修改 Desktop main/preload/shared API 和 server context catalog 入口

- [ ] 写 Picker 失败测试：`@` 与 `+` 使用同一目录，显示“插件”分类和说明；Esc、外部点击、再次点击 `+` 可关闭。
- [ ] 写富文本测试：选择插件插入原子节点，发送结构化 pluginId；历史恢复显示名称，不显示路径、MCP 配置或权限。
- [ ] 写回归测试：拖拽、粘贴、附件上传、Slash 和 `$Skill` 行为不变；切换会话不串草稿。
- [ ] Catalog API 只返回 pluginId、displayName、version、scope、origin、description 和能力类别。
- [ ] 失败保留草稿和引用；错误可关闭；插件初始化状态携带 sessionId、runId、pluginId，具体调用仍使用现有 Tool/Child 消息。
- [ ] 保持 feature flag 关闭，运行 Desktop Vitest、node/web typecheck 和 production build。
- [ ] 提交 `feat: add plugin mentions to composer`。

## 任务 8：组合回归与发布门槛

**文件：**

- 修改实际 feature flag、protocol capabilities、server health 和 Desktop gate 文件
- 更新 `docs/plugin-capability-invocation-design.md`、`docs/composer-capabilities-requirements.md`、`docs/skill-prompt-flow.md`、`docs/plugins-contributions-design.md`

- [x] 在 flag 关闭时验证普通 Prompt、`$Skill`、Goal、MCP、Native Tool 和 Plugin Agent 现有能力不被破坏。
- [x] 运行组合矩阵（管理更新按 route/Host、pool、frozen binding 分层自动验证）：

```text
普通 Run → @插件 Run → 普通 Run
@插件 + $同插件Skill
@插件A + $插件B Skill（拒绝）
$插件A Skill + $插件B Skill（拒绝）
PluginAgentRef → root → child → root final
Child 更换 cwd
@插件 Goal → initial → continuation → complete
插件管理更新：活动 Run 不变，Runtime 重建后的 Run 使用新状态
linked 目录外部变化：显式重载、应用重启或新会话后生效
Plugin Agent requiredMcpServers 与父 View server identity 取交集
已开始 Run 不透明重放，恢复创建新 Run
插件新增权限未批准
用户拒绝高风险 Tool
刷新后恢复插件引用和失败状态
```

- [x] 只在相关测试通过后运行：

```powershell
pnpm --dir packages/protocol test
pnpm --dir packages/core test
pnpm --dir packages/agent-runtime test
pnpm --dir packages/services test
pnpm --dir packages/server test
pnpm --dir apps/desktop test
pnpm check-types
pnpm --dir packages/agent-runtime test:pack
pnpm --dir apps/desktop build
node scripts/check-docs.mjs
```

- [x] 完整组合通过后同时升级协议能力版本、server feature 和 Desktop 显示条件；不提供旧客户端隐藏降级。
- [ ] 手动验证插件搜索、选择、授权、Tool、Agent、Goal 续跑、失败关闭和历史恢复。真实 Electron 手动验收未执行，逐步清单见设计文档第 15 节。
- [x] 把实际命令、通过数量和限制写回文档，提交 `docs: complete plugin capability invocation rollout`。

任务 8 自动化结果：protocol 56、core 166、agent-runtime 234、services 234、server 596、client 73、Desktop 873 项通过；全仓类型检查、test:pack、Desktop build 和 docs check 通过。普通 Coordinator 的 Child 按自身角色重建非插件基线，保留宿主上限和权限；选定插件的 Child 继续严格取父 View 子集。详见设计文档第 16 节。

## 自检结果

- 计划不再创建插件快照或 sealed resolution 表，也不要求持久化动态 schema。
- 每个 Run 使用 pluginId 读取当前插件，View 在活动 Run 内冻结，新 Run 可使用新版本。
- View 冻结具体 Tool/Skill/Agent binding 和 invoke target，不只冻结名称集合。
- 插件管理操作沿用现有 invalidation 重建暖 Runtime；不增加每 Run generation 检测。
- RunCapabilityView 同时保存 MCP server identity，支持 requiredMcpServers 与 Tool 的可靠交集。
- 插件新增权限必须先获批，调用前 owner/View guard 仍然存在。
- Skill 正文只通过 Skill tool result 进入上下文；Plugin Agent 仍走 root Agent Tool 链路。
- Goal 自动 Run 传播 pluginId，但每轮重新生成 View。
- requestId 只保证 admission 幂等；已开始 Run 不透明重放，外部副作用的 replay 需要业务幂等键或重新确认。
- 第一版不实现多个插件、会话固定、参数表单、旧数据兼容或附件继承。
