# Daemon 视觉工具所有权实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 在当前会话中逐任务实现此计划。步骤使用复选框（`- [ ]`）跟踪进度。

**目标：** 从 `@vykor/tools` 删除 `ImageToText` 和 `ImageGeneration`，由 daemon 完整定义并通过唯一的动态 `tools(context)` 入口注册。

**架构：** `createDaemonAgentLoader` 只负责把 durable session 和最终 Settings 翻译成 Agent 参数，不认识任何具体工具。daemon 创建固定视觉工具，并在 `tools(context)` 中与以后动态发现的工具统一返回；`toolOverrides` 继续只表达对默认 Agent 内置工具的覆盖。`ImageToText` 在 server 内同时处理授权附件、本地路径和 HTTP(S) URL，`ImageGeneration` 的执行细节也完全留在 server。

**技术栈：** TypeScript、Vitest、pnpm workspace、`@vykor/core` Tool API。

---

### 任务 1：统一 daemon 工具入口

**文件：**

- 修改：`packages/server/src/daemon/daemon-agent.ts`
- 修改：`packages/server/src/daemon/__test__/daemon-agent.test.ts`
- 修改：`packages/core/src/types/settings.ts`

- [x] 将 loader 测试改为通过 `tools({ session, settings })` 返回工具，并断言回调收到当前 session 和按 cwd 解析后的 Settings。
- [x] 运行 `pnpm --filter @vykor/server test -- daemon-agent.test.ts`，确认旧的数组接口导致测试失败。
- [x] 把 `DaemonAgentLoaderOptions.tools` 改为唯一的异步工具 Provider，删除 `imageGenerationTool`，loader 每次创建 Agent 时调用 Provider。
- [x] 保留 `toolOverrides` 和 `trustedToolOverrides` 的独立覆盖语义，不引入 `resolveTools`。
- [x] 删除 `Settings.imageGenerationBaseUrl` 以及 loader 对该字段的判断。
- [x] 重跑 server 定向测试并确认通过。

### 任务 2：把完整视觉工具迁入 daemon

**文件：**

- 创建：`packages/server/src/application/visual-tools/daemon-image-to-text-tool.ts`
- 创建：`packages/server/src/application/visual-tools/daemon-image-generation-tool.ts`
- 创建：`packages/server/src/application/visual-tools/tool-abort-scope.ts`
- 创建：`packages/server/src/application/visual-tools/index.ts`
- 创建：`packages/server/src/application/visual-tools/__test__/daemon-image-to-text-tool.test.ts`
- 创建：`packages/server/src/application/visual-tools/__test__/daemon-image-generation-tool.test.ts`
- 删除：`packages/server/src/application/attachment-tools/attachment-image-to-text-tool.ts`
- 删除：`packages/server/src/application/attachment-tools/__test__/attachment-image-to-text-tool.test.ts`
- 删除：`packages/tools/src/media/image-to-text.ts`
- 删除：`packages/tools/src/media/image-generation.ts`
- 删除：`packages/tools/src/media/index.ts`
- 删除：`packages/tools/src/media/__test__/image-to-text.test.ts`
- 删除：`packages/tools/src/media/__test__/image-generation.test.ts`
- 修改：`packages/tools/src/index.ts`
- 修改：`packages/server/src/application/daemon-application.ts`

- [x] 先写 server 测试，覆盖 `attachment_id` 的 Child → Root 授权 OCR、本地路径、HTTP(S) URL、混合输入拒绝和 Provider 错误脱敏；取消继续沿用迁移实现的 abort scope。
- [x] 运行 server 视觉工具测试，确认完整 daemon 工具尚不存在而失败。
- [x] 把视觉请求、输入校验、路径解析、超时和图片生成保存逻辑迁到 server；附件分支直接调用 daemon 的 OCR 服务，不再委托 `defaultTool`。
- [x] 在 `daemon-application.ts` 创建两个完整工具，并通过 `tools: async () => [...]` 返回；从 `@vykor/tools` 只导入 `fileReadTool`。
- [x] 删除 `@vykor/tools` 的视觉工具文件和公开导出。
- [x] 运行 server、tools 定向测试并确认通过。

### 任务 3：更新架构文档并收口验证

**文件：**

- 修改：`docs/agent-sdk.md`
- 修改：`docs/agent-framework-capability-boundary.md`
- 修改：`docs/superpowers/specs/2026-09-02-attachment-tool-overrides-design.md`

- [x] 文档明确 `@vykor/tools` 不提供视觉工具，daemon 拥有完整定义，loader 只有 `tools(context)` 一个普通工具入口。
- [x] 文档删除 `defaultTool: imageToTextTool`、按 `imageGenerationBaseUrl` 注册和“可复用视觉定义仍由 tools 导出”等旧描述。
- [x] 运行 server 与 tools 测试、`pnpm check-types`、`pnpm check-docs` 和 `git diff --check`；`check-docs` 仅剩既有的 `docs/contract-test-index.md` 断链。
- [x] 搜索确认生产代码中不存在 `imageGenerationBaseUrl`、`defaultTool: imageToTextTool`、从 `@vykor/tools` 导入两个视觉工具或 `DaemonAgentLoaderOptions.imageGenerationTool`。
