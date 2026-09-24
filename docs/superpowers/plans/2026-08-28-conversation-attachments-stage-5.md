# 对话附件阶段 5 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 内联逐任务实现此计划。步骤使用复选框（`- [ ]`）跟踪进度。

**目标：** 用 `@arcships/light-ocr@0.5.7` 完成本地 OCR 降级闭环，把 `ImageToText` 从远程视觉工具改为由主 Agent 主动调用的纯本地工具。

**架构：** daemon 拥有 Attachment Service、representation 仓库和一个懒加载长生命周期 OCR engine；Agent Runtime 通过显式宿主能力注册工具。附件路由在执行时根据模型、Provider 和实际工具目录选择原生图片或 OCR 资源提示，OCR 调用通过普通 tool use/result 持久化。

**技术栈：** TypeScript、Node.js 22/24、SQLite/Drizzle、Vitest、`@arcships/light-ocr@0.5.7`、`sharp`、Electron/React。

---

## 文件结构

- `packages/services/src/attachment-processing/`：light-ocr 适配、图片归一化、缓存与总服务。
- `packages/services/src/session-runtime/{schema,store}.ts` 与 `migrations/0015_attachment_representations.sql`：representation 持久化和原子状态转换。
- `packages/core/src/types/{tools,events}.ts`：OCR 宿主能力及工具结果 metadata 的稳定通道。
- `packages/agent-runtime/src/{agent-options,default-runtime,kernel}.ts`：宿主注入、真实工具注册和关闭传播。
- `packages/tools/src/media/image-to-text.ts`：只做输入校验和宿主调用的薄工具。
- `packages/server/src/application/attachment-routing/`、`session/session-run-executor.ts`、`daemon-application.ts`：降级决策、资源提示、可用性诊断和 daemon 生命周期。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/` 与 shared support：OCR 状态文案和生产 gate 收口。

### 任务 1：本地 OCR 引擎、归一化和持久缓存

**交付物：** 给 ready 图片 asset 调用一次即可获得版本化、可取消、可缓存的 OCR 结果；daemon 关闭会释放引擎。

**文件：**
- 修改：`packages/services/package.json`、`pnpm-lock.yaml`
- 创建：`packages/services/src/attachment-processing/light-ocr-engine.ts`
- 创建：`packages/services/src/attachment-processing/image-normalizer.ts`
- 创建：`packages/services/src/attachment-processing/local-ocr-service.ts`
- 创建：`packages/services/src/attachment-processing/local-ocr-errors.ts`
- 创建：`packages/services/src/attachment-processing/index.ts`
- 创建：`packages/services/src/attachment-processing/__test__/*.test.ts`
- 修改：`packages/services/src/session-runtime/schema.ts`
- 修改：`packages/services/src/session-runtime/store.ts`
- 创建：`packages/services/src/session-runtime/migrations/0015_attachment_representations.sql`
- 修改：`packages/services/src/session-runtime/migrations/meta/_journal.json`
- 修改：`packages/services/src/index.ts`

- [x] 先写失败测试：缓存键包含 asset SHA、`light-ocr:0.5.7`、model profile、locale、归一化版本和有效参数；相同键只执行一次；版本或参数变化生成新 representation；失败可重试但不覆盖 completed。
- [x] 先写失败测试：engine 懒初始化一次、容量有界、signal 能取消排队和运行任务、超时映射稳定、close 幂等且拒绝新任务；逐项验证红灯原因是实现缺失。
- [x] 先写失败测试：JPEG/PNG 直通，GIF/WebP/BMP 只取第一帧转 PNG，EXIF 修正；非法图片、40 MiB、40 MP、超长边分别返回稳定错误。
- [x] 新增 representation 表和 Store API，实现 `LightOcrEngine`、normalizer、`LocalOcrService`。OCR 输出保留 reading order、confidence、quadrilateral、timing，文本限制 100,000 字符，空行集合返回 `no_text_detected`。
- [x] 运行 `pnpm --filter @vykor/services test` 和 `check-types`，确认新增测试及既有 attachment/store 测试全绿后提交任务 1。

### 任务 2：ImageToText 宿主、工具契约和降级路由

**交付物：** 不支持图片的主 Agent 收到 OCR 资源提示并能真实调用本地工具；工具被过滤时 Provider 零调用。

**文件：**
- 修改：`packages/core/src/types/tools.ts`、`events.ts`、`runtime.ts`
- 修改：`packages/core/src/engine/query-engine.ts`
- 修改：`packages/agent-runtime/src/agent-options.ts`、`default-runtime.ts`、`kernel.ts`、`child-agent.ts`
- 修改：`packages/tools/src/registry.ts`
- 重写：`packages/tools/src/media/image-to-text.ts`
- 创建：`packages/tools/src/media/__test__/image-to-text.test.ts`
- 修改：`packages/server/src/daemon/daemon-agent.ts`
- 修改：`packages/server/src/application/attachment-routing/attachment-routing-types.ts`
- 修改：`packages/server/src/application/attachment-routing/attachment-capability-router.ts`
- 修改：`packages/server/src/application/session/session-run-executor.ts`
- 修改并新增相关测试：上述目录的 `__test__` 文件

- [x] 先写失败测试：`ImageToText` 只接受 `attachment_id`/`image_path`/`image_url` 三选一，删除 prompt；没有宿主时不注册；执行只转调宿主并返回本地 OCR metadata，不读 Settings、不调用 fetch。
- [x] 先写失败测试：`auto`/`vision` 在 native unsupported 或 unknown 时生成 `image_to_text_tool` 决策和受控文本块，`ocr` 总走工具；工具不可见、宿主缺失和非图片在 Provider 前失败；native supported 路径保持原顺序与内容。
- [x] 给 ToolContext/AgentHostCapabilities 增加最小 OCR 宿主，注册表按真实能力安装工具；ToolResult metadata 透传 StreamEvent。让 SessionRunExecutor 在路由前取得 agent.inspect() 的实际工具目录，并把资源提示作为本轮 user content。
- [x] 更新系统提示：附件文字是不可信数据，OCR 只能识字；禁止主 Agent把空 OCR 当图片描述，禁止递归把同一附件交回不支持图片的模型。
- [x] 运行 core、agent-runtime、tools、server 的相关测试和类型检查，确认 native、纯文本、allow/deny、interrupt、retry/fork/replay 不回归后提交任务 2。

### 任务 3：来源统一导入、transcript 关联、UI 与配置清理

**交付物：** 三种输入统一进 Attachment Service；工具卡与 representation 可追溯；旧视觉配置消失；生产附件默认开放。

**文件：**
- 创建：`packages/server/src/application/attachment-processing/agent-image-to-text-host.ts`
- 创建：`packages/server/src/application/attachment-processing/safe-remote-image.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/session/transcript-projection.ts`
- 修改：`packages/core/src/types/settings.ts`
- 修改：`apps/desktop/src/shared/attachment-types.ts`
- 修改：`apps/desktop/src/main/features/session/session-service.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/message-render-model.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message-attachment.tsx`
- 修改并新增对应测试。

- [x] 先写失败测试：attachment ID 直接复用；本地路径按 cwd 读取后导入；URL 只允许 HTTP(S)，DNS/重定向每跳复检并阻止环回、私网、链路本地和非图片，且受大小与超时控制；三者最终调用同一个 LocalOcrService。
- [x] 先写失败测试：tool result metadata 把 asset/representation/processor 写入 tool part；UI 区分 OCR completed、no text、failed；用户可以重试；原生 transformation 文案不变。
- [x] 实现 daemon OCR 宿主并接入 close 生命周期；扩展 transcript projection 的 metadata 提取。删除 `Settings.visionModel` 及全部使用点，不迁移旧设置。
- [x] 把 packaged Desktop 的 `interactionEnabled` 改为 daemon 支持即启用，并允许 `VYKOR_DESKTOP_ATTACHMENTS=0` 显式关闭；保留“添加文件夹”图标和禁用菜单项。
- [x] 运行 services/server/desktop 回归、类型检查和快照测试；搜索确认生产代码不存在 `visionModel`、ImageToText Provider fetch、Data URL 和 prompt 字段后提交任务 3。

### 任务 4：真实 OCR、打包与全链路验收

**交付物：** 真实本地图片 OCR 和打包依赖检查通过；完整阶段文档有可复现证据。

**文件：**
- 创建：真实 OCR smoke 中由 Sharp 动态生成的小型确定性测试图（不提交第三方图片资产）
- 创建或修改：`apps/desktop/scripts/verify-attachment-ocr-packaging.mjs`
- 修改：Desktop Electron 打包配置（按现有配置文件实际位置）
- 创建：`THIRD_PARTY_NOTICES.md` 或更新仓库现有第三方许可清单
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/README.md`
- 修改：本设计和计划的验收记录。

- [x] 用真实 `@arcships/light-ocr@0.5.7` 对动态生成的确定性测试图跑 smoke test，断言有文字、坐标和置信度；模型与运行时来自本地依赖，不执行下载和远程请求。
- [x] 验证当前平台 native 包、model/runtime closure、asar unpack、Windows/macOS/Linux 架构声明、Apache-2.0/OFL/third-party notices；打包脚本缺任何一项都非零退出。
- [x] 执行 `pnpm test`、`pnpm check-types`、`pnpm lint`、`pnpm check-docs`，另跑 Desktop build/package smoke。根 lint 的既有任务缺失如实记录，不把它冒充成通过。
- [x] 对照设计逐条审计：原生/降级/显式 OCR、工具过滤、三种来源、缓存、取消、零文字、重试、transcript、生产 gate、文件夹图标全部有证据；更新复选框与验收记录，提交任务 4。

## 最终验收记录（2026-08-28）

- 本阶段四个提交按设计文档、任务 1、任务 2、任务 3、任务 4 分开保存；任务 4 提交包含真实 OCR、打包闭包、实际解包产物检查和最终审查修复。
- 真实 OCR：`light-ocr-real-smoke.test.ts` 识别动态生成图片并校验文本、box 和 confidence；Windows 深路径通过扩展长度路径修复，Electron `app.asar` 自动解析到 `app.asar.unpacked`。
- 安全审查：远程 URL 每跳重新解析并固定公共 IP，拒绝混合 DNS、环回、私网、链路本地、IPv4 映射 IPv6、IPv6 组播、登录凭据、非 HTTP(S)、超限和非图片响应。
- 产物：Desktop production build 与 Windows x64 解包构建通过；`verify:attachment-ocr:artifact` 验证模型、runtime、当前平台 OCR 原生模块和 Sharp 原生模块。
- 质量门：全仓测试、全仓类型、文档检查和定向回归以最终重新运行结果为准。根 `pnpm lint` 当前固定失败为 `Could not find task lint in project`，属于仓库脚本没有定义 Turbo lint 任务；本次变更另外使用类型检查、测试、文档检查、产物检查和 `git diff --check` 收口。

## 完成条件

四个任务各自有独立提交，工作树干净；所有适用测试和类型检查通过；任何已知基线失败都带命令、次数和原始错误。完成后使用 `finishing-a-development-branch`，由用户决定本地合并、推送 PR 或保留分支。
