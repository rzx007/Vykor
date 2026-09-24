# 设计：Services 记忆四件套（E.6 第一刀）

> 状态：当前实现。记忆体系全景见 [memory-system.md](./memory-system.md)。
> 移植 Python services 的四个记忆/上下文内功模块（~1170 行），
> 与 C.5 personalization 同脉。team scope / lsp 真 AST 留后续刀。

## 四个模块

| 模块 | Python 源 | 行数 | 做什么 |
|------|-----------|------|--------|
| tool_outputs | services/tool_outputs.py | 55 | 工具输出上下文预算：inline/preview/microcompact 字符阈值（env 可调），`isMicrocompactableToolResult`（mcp__ 前缀或超阈值的工具结果可被老结果清理） |
| session_memory | services/session_memory/ | 139 | 确定性会话 checkpoint：`<dataDir>/session-memory/<projname>-<sha1cwd12>/<sessionId>.md`，由 task_focus_state（goal/next_step/verified/artifacts）+ 最近 80 条消息摘要构成，12k 字符截断；compact 边界注入 |
| memory_extract | services/memory_extract/ | 261 | 回合结束后让 LLM 提取「持久记忆」候选（JSON，≤3 条），写进 memory 体系；若本回合已有人写过 memory 目录则跳过 |
| autodream | services/autodream/ | 717 | 「梦境整合」：定期用 LLM 重组/合并/清理 memory 文件（带文件锁 + 整目录备份回滚 + 整合 prompt） |

## TS 落位

全部进 `packages/services/src/`（已有 tasks/lsp/compact 等子目录的既有包）：
`tool-outputs.ts`、`session-memory.ts`、`memory-extract.ts`、`autodream/`。

## 关键适配决策

- **LLM 调用**：memory_extract/autodream 经 `StreamingMessageClient`（TS api 包
  统一接口）注入，测试用 fake client 返回固定 JSON。
- **memory 体系对接**：Python 用 add_memory_entry/scan_memory_files/
  build_memory_manifest；TS 对应 `@vykor/memory` 的 MemoryManager（B.4
  已有 frontmatter/MEMORY.md 维护）。接口名不同处做薄适配。
- **team memory secrets 检查**：Python memory_extract 调
  check_team_memory_secrets/validate_team_memory_write_path——TS memory 没有
  团队隔离（PLAN 已记 Phase C 缺口）→ 本轮跳过，差异表记录。
- **autodream 锁**：实现时改为自写 lock.ts——mtime 即「上次整合时间」+
  PID 活性检测 + 失败回滚 mtime 的语义与 swarm 的 exclusiveFileLock（互斥临界区）
  并不同构，复用反而别扭。
- **dataDir**：session_memory 与 memory 目录都落在 core 的数据目录下，并按
  `<项目名>-<sha1(cwd)前12>` 隔离项目。
- **触发接线**（最后一轮，对照 Python 消费点 grep 确认）：
  - tool_outputs/session_memory → compact-service（B.2 的 compact 链路）；
  - memory_extract → 回合完成后 best-effort（参考 Python engine/loop 调用点）；
  - autodream → `/dream` 手动触发，或每轮完成后按配置阈值自动触发。

## 与 Python 差异（实现中补全）

| 点 | Python | TS | 原因 |
|----|--------|----|------|
| team secrets 检查 | memory_extract 写前校验 | 跳过 | TS memory 无团队隔离（Phase C 缺口） |
| autodream 锁 | 自带 lock.py | 自写 mtime lock | 与 Python 语义对齐，兼作上次整合时间 |
| 日志 | logging | 静默/返回值 | TS 无 logger 基建 |

## 测试

- tool_outputs：env 覆盖/非法值回退/最小值钳制；microcompactable 三分支。
- session_memory：路径哈希稳定性、checkpoint 文档结构（含 task_focus 状态）、
  12k 截断、compact text 包装、消息摘要三形态（text/tool_uses/tool_results）。
- memory_extract：has_memory_writes_since 路径判定、prompt 构造、JSON 解析
  （含坏 JSON 容错）、fake client 端到端写盘、跳过分支（消息不足/已写过）。
- autodream：备份/回滚、锁互斥、prompt 构建、fake client 整合循环。

每轮 `pnpm check-types` + `pnpm test` 全绿；TDD。

## 接线现状（审查后补记）

- ✅ /dream、/remember 斜杠命令；REPL/TUI/print 每轮 checkpoint 写入。
- ✅ compact 边界的 checkpoint 读回已接入 attachmentsProvider；tool_outputs 阈值已接进 compact/microcompact 链路。
- ✅ memory_extract 每轮自动触发已接入，默认开启，可用 `memory.autoExtractEnabled=false` 关闭。
- ✅ executeAutoDream 自动触发已接入，默认关闭，受 `memory.autoDreamEnabled` 与 hours/sessions 阈值控制。
- 留待：team scope 隔离与密钥扫描。
- 会话文件命名：TS 是 `<id>.json`（Python `session-*.json`），扫描器两者兼容；
  整合 prompt 里的 `session-*.json` 提示文案沿用 Python 原文。
