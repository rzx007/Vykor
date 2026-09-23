# 已报告问题

> 每条格式：`- <日期> — [严重|中等] `文件:行`（可多个）：<问题与影响>；引入提交 `<sha>`；状态 `pending-review`。`
> 写入前必须先与本节既有条目比对「引入提交 + 文件位置」，重复的不再写。

- 2026-08-29 — `packages/server/src/application/attachment-processing/agent-image-to-text-host.ts:46-48,87-95` / `packages/permissions/src/index.ts:108-129,199-203`：`ImageToText` 接受绝对或越界 `image_path`，而权限检查不识别该字段，导致自动批准工具时绕过路径拒绝规则并 OCR 读取工作区外图片；引入提交 `ef842b320dfcd9732a0e8cf7a3b78aa7e7b25c8c`；状态 `pending-review`。
- 2026-08-30 — `apps/desktop/src/renderer/src/components/desktop/conversation-page/message-attachment.tsx:149-177` / `apps/desktop/src/main/features/attachment/attachment-service.ts:242-256`：历史消息中的每张图片都会立即下载并长期保留最多 10 MiB 的原图 Blob，无懒加载、缩略图、并发或总内存上限，合法的大图会话可稳定耗尽 Desktop 渲染进程内存；引入提交 `d0abb414f9b95525aad514511cace50d60323edb`；状态 `pending-review`。
- 2026-09-02 — `packages/agent-runtime/src/default-node-terminal.ts:28-40` / `packages/terminal-node/src/agent-terminal-host.ts:114-145` / `packages/terminal-node/src/local-terminal-provider.ts:64-88`：默认 Agent Terminal 不读取 sandbox 设置并把所有会话硬编码为 `runtime: "local"`，使启用沙箱的 Agent 仍通过宿主机 PTY 执行 `JobSend` 输入；同时命令 deny 规则只检查 `input.command` 而 `JobSend` 使用 `input.data`，可绕过沙箱及命令黑名单修改工作区外文件；引入提交 `cbecbbe2528c1f4c98735d4d5cf44287700cbe97`；状态 `pending-review`。
- 2026-09-08 — `packages/permissions/src/index.ts:81-86` / `packages/agent-runtime/src/default-runtime.ts:189-200` / `apps/desktop/src/main/features/settings/settings-service.ts:92-111`：切换到 WSL 时没有迁移或预检现有 Windows 绝对路径 permission.pathRules，但运行时把它们视为致命配置错误；已有 Windows 路径规则的用户保存 WSL 设置后，所有新会话在构造 PermissionChecker 时稳定失败，无法执行任何任务；引入提交 `b1deeecffc80ca97a890fd47cb7b3d18f0fe267a`；状态 `pending-review`。
- 2026-09-14 — `apps/desktop/src/main/features/workspace/workspace-service.ts:98-130` / `apps/desktop/src/shared/safe-image-preview.ts:17-41` / `apps/desktop/src/renderer/src/components/desktop/tools/file-image-preview.tsx:20-48`：工作区图片预览只按压缩文件大小与魔数放行，未限制像素尺寸或解码内存；合法的高压缩比 PNG/JPEG/GIF/WebP 可在 50 MiB 限制内声明数 GB 像素，打开文件标签时交给 Chromium 解码，稳定耗尽 Desktop 渲染进程内存并崩溃；引入提交 `39fa8a8f1d05a0c618f30bbad886e36da4df61f6` / `186b454916ba1e652c7cc76edb1726ed20bee7ec`；状态 `pending-review`。
- 2026-09-21 — [中等] `packages/server/src/application/session/run-stall-watchdog.ts:48-49` / `packages/server/src/application/session/session-run-executor.ts:252-276`：无进展看门狗把「活动」只定义为 run 记录 / 会话任务 / 消息三者的 updatedAt 前进（`readActivity`），且只豁免「等待权限」与「运行中的子任务」，没有豁免正在执行的长工具调用；真空期默认 10 分钟（`DEFAULT_RUN_STALL_TIMEOUT_MS`，生产代码无任何覆盖点），而工具只在 tool.started / tool.completed 两个时刻写库、执行期间没有增量输出落库，因此一次超过 10 分钟的阻塞工具（长构建、长测试、pnpm install、对后台 shell 的 JobWait）会被判为卡死并以「运行超过 10 分钟无进展，已自动终止」中断，正常的长任务被误杀并可能留下半途副作用；引入提交 `6aeb2a3048741cf1cf57a9b5fedc14c4e66b1054` / `1d5440876277b3ac5dd198e074c265268a03110c`；状态 `pending-review`。
- 2026-09-21 — [中等] `packages/server/src/application/channel/channel-application-service.ts:251,265` / `packages/channels/src/impl/feishu.ts:377`：入站附件下载与导入全程没有超时、没有 AbortSignal，且整段处理串行在会话车道内（`withConversationLane`，键为 connector+accountId+chatId+threadId）；飞书侧下载流一旦中途停滞（对端 hang、慢网），`attachments.import` 只按 maxBytes 拦超大、不拦停滞，Promise 永不 settle，该会话后续入站消息将永久排队且无任何错误上报，直至重启守护进程；引入提交 `89a5e40bbecc088e06542437efa9387869e48493` / `0888d1382f252ba3005d3c6c89f907cdddccb419`；状态 `pending-review`。
- 2026-09-21 — [中等] `packages/server/src/application/session/run-stall-watchdog.ts:50` / `packages/server/src/application/session/session-run-executor.ts:276-283`：为修掉「长工具调用被误杀」而在豁免条件里加入的 `hasRunningTool` 没有任何时间上限——只要该 run 的消息里存在一个 `type:"tool"` 且 `status:"running"` 的 part，看门狗就永远不再判停；而工具 part 只在 `tool_use_start` 写成 running、只在 `tool_use_end` 翻成 completed/failed，run 未进入终态时没有任何其他路径（含超时、重启对账）会把它清掉，terminal/shell/JobWait 这条最容易挂死的链路又不使用 `createToolAbortScope`（只有图像生成/OCR/飞书推送/网页抓取有超时），因此「run 卡死在工具里」这一看门狗本来的核心场景变成永久检测不到：run 会一直停在 running，直到用户手动中断，而修复前它会在 10 分钟后被自动终止；引入提交 `7df7e34e98f784c341a3d135588bc5e4395b45bf`；状态 `pending-review`。

## 已审核基线

> 每晚 21:00 的自动审查只读此节最后一条来判断待审区间：审「最后基线日期的次日 00:00:00」到「昨天 23:59:59」。这条基线本身就是审核邮戳——即使某天零发现也要写一行，否则那天会被反复重审。
> 每行格式：`- <日期> — 范围 <first7>..<last7>（N 个提交）；发现 严重 X / 中等 Y`
> **每天最多审 1 天**：一次运行只审最早的未审日期，绝不在一次运行里连审多天；剩余积压留给后续运行逐日消化。

- 2026-09-14 — 起点基线。此前只有零散人工审查记录（见上），无逐日覆盖；2026-09-15 起为待审积压。
- 2026-09-19 — 范围 4e5a4df0..c5433b5c（2026-09-15..2026-09-19，304 个提交）；用户决定不回溯审查，**跳过**（非审查通过，这 5 天不做补审）。基线推进到此日，下一待审日为 2026-09-20。
- 2026-09-20 — 范围 e0a2d8cb..0e8e945f（62 个提交）；发现 严重 0 / 中等 2
- 2026-09-21 — 范围 c5f3931c..0d5d7abf（70 个提交）；发现 严重 0 / 中等 1
