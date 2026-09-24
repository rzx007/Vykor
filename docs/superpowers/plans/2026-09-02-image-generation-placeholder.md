# 图片生成占位符与多图展示实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在桌面助手消息中用专用占位符表示正在运行的 `ImageGeneration`，成功后用响应式拼图显示一张或多张现有附件。

**架构：** 桌面消息模型把 `ImageGeneration` Tool 转换为专用显示单元，不再放入普通 Tool 活动组。新组件只读取 Tool 已有的状态、输入和创建时间；生成附件继续使用既有附件部件和附件 IPC，不改服务端协议与存储。

**技术栈：** TypeScript、React、Tailwind CSS、Vitest、jsdom。

---

## 文件结构

- 修改 `message-render-model.ts` 及测试：识别专用生图单元，并区分生成附件组。
- 创建 `image-generation-message.tsx` 及测试：渲染占位、失败、取消、缺失附件和响应式拼图。
- 修改 `assistant-message.tsx`：接入生图组件并传入流式状态。
- 修改 `message-attachment.tsx` 与 `attachment-image-preview.tsx`：允许拼图中的图片填满网格，默认样式不变。
- 修改 `transcript.test.ts`：验证助手消息最终组合行为。

### 任务 1：消息模型识别生图 Tool 与生成附件

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/message-render-model.ts`
- 测试：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/message-render-model.test.ts`

- [x] **步骤 1：编写失败测试**

输入 `toolName: "ImageGeneration"`、`status: "running"`、`input.ratio: "16:9"` 的真实 `DesktopSessionPart`，断言输出 `type: "image_generation"`，且不输出普通 `tool` 单元。加入相同 `toolUseId`、`metadata.source: "image_generation"` 的附件，断言专用单元知道附件已经到达，并输出独立的 `generated_attachments` 单元。普通附件仍输出 `attachments`。

测试应能抓住“生图仍进入普通工具组”和“普通附件被错误套用拼图”两类回归。

- [x] **步骤 2：运行测试验证红灯**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/message-render-model.test.ts
```

预期：失败，因为当前模型只有 `tool` 和通用 `attachments` 单元。

- [x] **步骤 3：实现最少模型逻辑**

新增 `image_generation` 联合类型，包含 `call` 和 `hasAttachments`；新增 `generated_attachments` 联合类型，包含 `parts`、`toolUseId` 和安全归一化后的 `ratio`。先扫描生成附件与 Tool 的关联，再按原顺序遍历部件。比例只接受 Tool Schema 已支持的八个值，其余回退为 `1:1`。

- [x] **步骤 4：运行模型测试验证绿灯**

执行步骤 2 的命令，预期全部通过。

### 任务 2：实现占位状态与等待文案

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx`

- [x] **步骤 1：编写失败测试**

使用 jsdom、真实组件和假时间验证：运行时出现“正在生成图片”；`16:9` 产生对应比例标记；20 秒显示真实等待时间；52 秒显示耗时较长文案。另测 `failed`、`interrupted`、`completed + hasAttachments` 和 `completed + !hasAttachments`。成功且已有附件时组件返回空内容；流式完成但附件未到达时显示“正在整理生成结果”；非流式时显示缺失附件提示。

测试应能抓住状态分支写错、虚假进度和完成后占位符不消失的问题。

- [x] **步骤 2：运行组件测试验证红灯**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts
```

预期：失败，因为组件文件尚不存在。

- [x] **步骤 3：实现最少占位组件**

实现 `ImageGenerationMessage({ call, hasAttachments, streaming })`。运行态每秒更新本地时间并在离开运行态时清理 timer；每秒变化的时间不放进 live region。比例使用静态 class 映射并带最大宽高。失败详情复用 `formatValue(call.output)` 并默认折叠。在 `AssistantMessage` 中渲染专用单元。

- [x] **步骤 4：运行组件和模型测试验证绿灯**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts src/renderer/src/components/desktop/conversation-page/message/message-render-model.test.ts
```

预期：全部通过。

### 任务 3：实现生成图片响应式拼图

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message-attachment.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/attachment-image-preview.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript.test.ts`

- [x] **步骤 1：编写失败测试**

渲染 1、2、3、4、6 张真实附件，断言 `data-image-count` 和布局标记。6 张时初始只渲染 4 张和 `+2`；点击展开后 6 个文件名全部出现并显示“收起”；再次点击恢复 4 格。普通附件不得出现拼图标记。`MessageAttachment` 的新 `fill` 用例断言预览填满网格；默认用例继续断言 `size-24`。

测试应能抓住“多图仍横向滚动”“超过四张全部铺开”和“普通附件样式被改坏”的问题。

- [x] **步骤 2：运行拼图测试验证红灯**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts src/renderer/src/components/desktop/conversation-page/message-attachment.test.ts src/renderer/src/components/desktop/conversation-page/transcript.test.ts
```

预期：新增拼图与 `fill` 断言失败。

- [x] **步骤 3：实现最少拼图逻辑**

实现 `GeneratedImageGallery`：默认取前四张；超过四张时第四格增加可访问的 `+N` 按钮，展开后渲染全部并显示“收起”。布局为 1 张单格、2 张两列、3 张第一格跨两行、4 张 2×2；窄宽度保持两列且不横向滚动。给 `MessageAttachment` 和 `AttachmentImagePreview` 增加可选 `fill`，仅由拼图使用。`AssistantMessage` 将 `generated_attachments` 交给新组件，通用附件继续使用 `AttachmentGroup`。

- [x] **步骤 4：运行拼图测试验证绿灯**

执行步骤 2 的命令，预期全部通过。

### 任务 4：完整桌面回归

- [x] **步骤 1：运行桌面类型检查**

```powershell
pnpm --filter @vykor/desktop typecheck
```

预期：Node 和 Web 两套 TypeScript 检查均退出 0。

- [x] **步骤 2：运行完整桌面测试**

```powershell
pnpm --filter @vykor/desktop test
```

预期：失败数为 0。

- [x] **步骤 3：检查差异与范围**

运行 `git diff --check` 和 `git status --short`，确认本功能没有新增 `packages/server`、`packages/services` 或协议改动；保留工作区原有附件系统变更，不提交、不推送。

### 任务 5：弱化失败卡片的视觉警报感

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.tsx`
- 测试：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts`

- [x] **步骤 1：编写失败测试**

渲染失败状态，断言用户看到 `这次没有生成出图片`；失败卡片使用中性 `border-border`、`bg-muted` 和普通文字颜色，不再把 `text-destructive`、`border-destructive` 或 `bg-destructive` 应用到整个卡片。错误详情仍可展开。

- [x] **步骤 2：运行测试验证红灯**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts
```

预期：失败，因为当前标题仍是 `图片生成失败`，且卡片仍使用 destructive 红色样式。

- [x] **步骤 3：实现最小样式调整**

保持现有状态分支和详情结构不变，将失败卡片标题改为 `这次没有生成出图片`。失败容器复用中性卡片样式，图标单独使用低饱和的暖色文字类；详情文字保持 `text-ui-muted`。

- [x] **步骤 4：验证绿灯与桌面回归**

运行目标测试、桌面端完整测试、TypeScript 检查、本次文件 ESLint 和 `git diff --check`，预期全部退出 0。

### 任务 6：让紧凑占位区域铺满卡片

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.tsx`
- 测试：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts`

- [x] **步骤 1：编写失败测试**

渲染 `9:16` 运行态，断言外层状态卡片使用紧凑的 `max-w-52`，内部带 `data-image-ratio` 的占位区域使用 `w-full aspect-[9/16]` 且不再单独限制最大宽度。另断言单图结果仍使用原有的最终图片比例和宽度映射。

- [x] **步骤 2：运行测试验证红灯**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts
```

预期：失败，因为当前外层仍固定为 `max-w-xl`，内部 `9:16` 区域使用 `max-w-64`，从而在卡片右侧留下空白。

- [x] **步骤 3：实现最小布局修复**

保留最终图片使用的 `ratioClassNames`。新增仅用于占位状态的比例 class 和紧凑宽度 class 映射；外层状态卡片应用紧凑宽度，内部应用比例并始终保持 `w-full`。不增加图片数量推测或协议字段。

- [x] **步骤 4：验证绿灯与桌面回归**

运行目标测试、桌面端完整测试、TypeScript 检查、目标文件 ESLint 和 `git diff --check`，预期全部退出 0。

## Task 7：收紧占位符和失败状态

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.tsx`
- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts`

1. 先把测试改成固定宽高的紧凑占位符、单个比例画布、稳定标题和第二行耗时文案。
2. 把失败状态改成无外框的行内摘要，详情默认收起并可展开到弱化的内嵌区域。
3. 保持成功图片画廊、取消状态和缺失附件状态的现有行为。
4. 运行目标测试、相关桌面测试、类型检查和格式检查。

## Task 8：统一其余图片生成状态

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.tsx`
- Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts`
- Modify: `docs/superpowers/specs/2026-09-02-image-generation-placeholder-design.md`

- [x] **步骤 1：编写失败测试**

  渲染取消、整理中和附件缺失三种状态，断言它们都使用统一的 `data-image-generation-status` 行内容器，并且不包含外框或背景类；同时断言各自图标使用中性、品牌色和低饱和暖色。

- [x] **步骤 2：运行目标测试并确认失败**

  运行 `pnpm test -- src/renderer/src/components/desktop/conversation-page/message/image-generation-message.test.ts`，预期新增断言因旧卡片仍包含边框和背景而失败。

- [x] **步骤 3：实现统一状态行**

  让 `ImageGenerationStatusCard` 对取消、整理中、附件缺失和失败共用无外框的 `flex items-center gap-2 py-1.5 text-xs` 行内结构；保留失败详情的原生 `details/summary` 交互，不改变生成中占位面板和成功图片画廊。

- [x] **步骤 4：验证**

  运行目标测试、桌面端完整测试、`typecheck:web`、目标 ESLint、Prettier 和 `git diff --check`，预期全部退出 0。
