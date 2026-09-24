# Phase 2 Task 2 Fix Round：限定当前 Run 的成功记忆写入

## 审查问题

初始 Task 2 实现只要在完整历史中看到名为 `Remember` 的 tool use，就跳过自动提取。这会造成两个错误：

- 前一个 run 成功调用过 `Remember` 后，后续 run 会一直被旧历史抑制。
- 当前 run 的 `Remember` 即使执行失败，或者只有其他工具成功，也会被误判为已经写入记忆。

## 修复结果

- 重复提取判定只扫描最新 user 消息起始的当前 run 消息窗口；更早 run 的工具调用不参与判断。
- 当前窗口先收集受管记忆写入的 tool-use ID：
  - managed `Remember`；
  - 继续通过既有 `isMemoryWriteToolCall()` 受管目录检查的 `Write` / `Edit`。
- 只有同一窗口中存在 `toolUseId` 匹配且 `isError !== true` 的 tool result，才视为写入成功并跳过自动提取。
- `agent.remember()` 的公开无参数维护入口、完整历史提取上下文、Memory Markdown 格式和目录均未改变。

## 修改文件

- `packages/agent-runtime/src/memory-runtime.ts`
- `packages/agent-runtime/src/memory-runtime.test.ts`
- `.superpowers/sdd/2026-09-01-agent-runtime-default-capabilities-phase-2/task-2-fix-round-report.md`

## RED/GREEN 证据

- RED：`memory-runtime.test.ts` 为 2 failed / 3 passed。
  - 前一 run 的成功 `Remember` 错误地让新 run 返回 `main conversation already wrote memory`。
  - 当前 run 中匹配失败的 `Remember` 加一个无关成功结果，仍被错误判定为写入成功。
- GREEN：加入当前窗口与 tool-use/result 成功配对后，`memory-runtime.test.ts` 5/5 通过。
- 正向测试明确要求当前窗口中存在匹配成功的 `Remember` result 才跳过；受管 `Write` 回归也补上匹配成功 result。

## 验证结果

```powershell
pnpm --filter @vykor/agent-runtime exec vitest run src/memory-runtime.test.ts src/remember-tool.test.ts src/sdk.test.ts
pnpm --filter @vykor/tools exec vitest run src/file/__test__/managed-persistence-path.test.ts
pnpm --filter @vykor/agent-runtime check-types
git diff --check
```

- Memory、Remember、SDK：3 个测试文件，21/21 通过。
- 受管持久化路径安全：1 个测试文件，3/3 通过。
- agent-runtime TypeScript 类型检查：退出 0。
- `git diff --check`：退出 0，仅有 Git 的 CRLF 提示。

## 边界说明

- 普通 `Write` / `Edit` 不会按名称被当作成功记忆写入；仍必须同时满足既有受管路径判定与匹配成功 result。
- 没有新增 Memory object override、服务或存储格式。
- 用户 staged 文件 `apps/desktop/src/main/features/session/session-service.test.ts` 未修改、未取消暂存，也不会进入 fix commit。
