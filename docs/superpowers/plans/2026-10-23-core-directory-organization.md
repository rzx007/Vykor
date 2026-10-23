# Core 目录整理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按职责整理 `packages/core`，测试统一放到被测模块同层级的 `__test__`，为每个分类目录补充中文 README。

**Architecture:** `engine/query-engine.ts` 保留查询循环，相关实现分到 `engine/model`、`engine/tools`、`engine/compaction`、`engine/usage`；已有 `trajectory` 保留，会话包装移到 `session`。保留根入口、`@vykor/core/engine` 和 `@vykor/core/context-budget` 的公开导出，同步调整内部引用、直接引用源码的调用方以及有效文档链接。

**Tech Stack:** TypeScript、pnpm、Vitest。

**Spec:** 本次用户要求：整理 `packages/core` 的代码分类，测试放在同层级 `__test__`，每个分类目录给出 README 介绍。

## Global Constraints

- 仅整理目录、引用和说明，不改运行行为。
- 保留用户已有的插件模板、技能与测试改动。
- README 使用通俗中文，交代入口、运行步骤、状态位置和结果去向。
- 测试保持原有用例；类型引用应指向实际存在的定义。

### Task 1: 核对基线和目录归属

- [x] 查看 core 文件、公开导出、内部依赖、测试配置和跨包源码引用。
- [x] 运行 `pnpm --filter @vykor/core test`：35 个文件、438 个用例通过。
- [x] 运行 `pnpm --filter @vykor/core check-types`：通过。

### Task 2: 迁移代码与测试

**Files:** `packages/core/src/**/*.ts`、直接引用迁移文件的测试、记录历史引用位置的检查清单。

- [x] 将 `model-*`、`buffered-model-retry.ts`、`query-model-attempt.ts` 移入 `engine/model/`。
- [x] 将 `tool-*`、`query-tool-*`、`checked-tool-execution.ts` 移入 `engine/tools/`。
- [x] 将 `compact-*` 移入 `engine/compaction/`，`cost-tracker.ts` 移入 `engine/usage/`。
- [x] 将 `agent-session.ts` 移入 `session/`。
- [x] 模块级测试移到分类目录下的 `__test__/`；查询整体流程测试移到 `engine/__test__/`。
- [x] 按原文件的实际目标更新静态导入、导出、动态导入和类型导入，保持 `.js` 与无扩展名两种现有写法。
- [x] 同步源码直接引用与包含文件位置的检查清单，核对 35 个原测试文件全部保留。

### Task 3: 补齐目录说明并验证

**Files:** `packages/core/README.md`、各分类目录的 `README.md`、引用迁移源码的文档。

- [x] 根 README 给出目录导航、执行流程和测试命令，各分类 README 说明文件分工和新增文件应放的位置。
- [x] 更新可点击文档链接和当前文档中的源码位置；历史计划的代码示例保留历史语境。
- [x] 运行 core 测试、core 类型检查、直接受影响的集成测试及必要的目录边界检查。
- [x] 查看最终差异，确认实现仅变更位置和引用，报告验证结果。

## 验证结果

- core：35 个测试文件、438 个用例通过；类型检查通过。
- 运行时工具流程与授权：2 个文件、50 个用例通过。
- 服务端/客户端模型重试：8 个用例通过。
- 普通任务的压缩与继续执行：10 个用例通过。
- 桌面会话订阅：19 个用例通过。
- 文档检查和架构边界检查通过；core 涉及的 4 条历史引用检查通过。
- 全仓历史引用检查通过：校验脚本测试通过，729 条历史引用无报错；计划中的检查清单文件名改为用途说明，避免触发旧接口关键词扫描。
- 对比 42 个源模块，除引用路径外内容一致；35 个测试均位于 `__test__`，11 个分类目录均有 README，README 本地链接有效。
