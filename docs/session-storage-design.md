# 设计：Session 存储增强（E.6 第二刀）

> 状态：历史设计。本文描述已经退场的项目级 JSON snapshot，不是当前 daemon 存储契约。
>
> 当前 SQLite、Repository、Transaction 与 `SessionStore` 边界见 [Session Runtime 存储架构](./session-runtime-storage-architecture.md)；请求流程见 [Daemon Application Architecture](./daemon-application-architecture.md)，固定记录格式见 [Durable Execution Data Model](./durable-execution-data-model.md)。

## 历史背景

旧 TS 入口（apps/cli main.ts 自带逻辑 + services/session 旧 SessionStorage 类）曾经有这些缺口：
- 会话平铺在全局 sessions 目录，**多项目混在一起**；
- 无 `latest.json`（`--continue` 靠文件名排序猜最新）；
- 不持久化 tool_metadata；无 Markdown 导出；无 summary 字段。

后来曾经实现过一版项目级 JSON snapshot，位置是 `packages/services/src/session/storage.ts`。
这套代码已经移除；本节只保留历史设计意图，不能作为当前 API 或测试入口引用。

- 项目目录形如 `<sessionsDir>/<项目名>-<sha1(cwd)前12>/`。
- snapshot 保存逻辑曾经计划：
  - `latest.json` + `session-<id>.json` **双写**（原子写）；
  - tool_metadata 按白名单 `_PERSISTED_TOOL_METADATA_KEYS` 过滤 + 深度 sanitize；
  - summary 取首条非空 user 消息前 80 字符；记 message_count/created_at。
- snapshot 读取逻辑曾经计划支持 latest、列表、按 id 读取和 transcript markdown 导出。

## 适配决策

- 消息形状：宽松 `{role?/type?, content}`（与 session-memory 同思路），
  不引 pydantic 式校验。配对修复做在 **load 侧**（Python save/load 双侧）：
  读回时剔除尾部悬挂 tool_use 与孤儿 tool_result——崩溃/MaxTurns 中断落盘的
  断链历史 resume 后会被 API 直接 400，必须修复。
- 旧项目级 JSON snapshot API 已从 `@openharness/services` 导出中移除。
- ✅ `/export` 命令：`/export [filename] [--json]`，`.json` 后缀或 `--json` 标志
  输出 JSON（session_id/model/exported_at/messages），否则 Markdown；默认写
  `~/.openharness-ts/data/exports/`。`/export` 走独立渲染路径（不依赖旧 cwd/storage）。
- 留待：systemPrompt 传空串、usage 为 TS camelCase（与 Python 快照不互换）；
  compact 侧读回 checkpoint。
- 已删除未被主线使用的 `SessionStorage` 类、`~/.openharness-ts/sessions/<id>.json`
  平铺回退，以及项目级 JSON snapshot functions。
- `/dream` 的 `listSessionsTouchedSince` 当前扫 `getSessionsDir()` 平铺根，
  接线后改传项目分目录。

## 测试

- 当前权威存储测试在 `packages/services/src/session-runtime/__test__`。
- 旧文件型 snapshot 测试已随 `packages/services/src/session` 删除。
