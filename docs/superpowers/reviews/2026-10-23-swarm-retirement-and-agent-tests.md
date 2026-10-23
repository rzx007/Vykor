# swarm 退役与 Agent 跨包测试迁移验收

> 状态：当前清理记录；仅覆盖 swarm 删除及测试归属调整。

## 实施范围

- 删除无人调用的 swarm 包及自身测试；移除架构策略中的包登记、允许依赖和来源目录，移除 Server/Client 联合类型配置的路径别名及锁文件 importer。
- 团队仍由 coordinator 的 TeamRegistry、Node 宿主和 Kernel child 管理；没有建立兼容转发或新的团队实现。历史方案中的 swarm 描述保留为历史，不作为当前入口。
- 原 Runtime 的 node/integration 目录不再保留测试。跨包组合测试迁到仓库 tests，工具自身测试迁回 tools，不增加 tools → core 的依赖。
- 跨包测试所需 SDK 开发依赖从 Runtime 移到根包；根包显式声明权限、提示词和工具依赖。锁文件没有升级外部依赖版本。

## 测试迁移位置

| 原 node/integration 文件 | 新位置 |
| --- | --- |
| file-protocol-replay.integration.test.ts | tests/agent-integration/file-protocol-replay.integration.test.ts |
| file-workflow.integration.test.ts | tests/agent-integration/file-workflow.integration.test.ts |
| shell-output-engine.test.ts | tests/agent-integration/shell-output-engine.test.ts |
| tool-input-recovery.test.ts | tests/agent-integration/tool-input-recovery.test.ts |
| upstream-retry.integration.test.ts | tests/agent-integration/upstream-retry.integration.test.ts |
| write-content-reuse.integration.test.ts | tests/agent-integration/write-content-reuse.integration.test.ts |
| job-tools.test.ts | 工具行为迁到 packages/tools/src/job/job-tools.test.ts；Engine 等待时限用例迁到 tests/agent-integration/job-tools.integration.test.ts |
| tool-search.test.ts | 工具行为迁到 packages/tools/src/meta/tool-search.test.ts；两个真实 ToolRegistry 用例迁到 tests/agent-integration/tool-search.integration.test.ts |

使用 TypeScript 语法树核对迁移前后的每个测试声明及正文，64 段逐一相同；参数化展开后共 81 项。只调整导入、目录和必需的测试辅助函数，没有删除有效断言。

## 普通 CI 覆盖

- 根 pnpm test 新增 test:agent-integration 命令，使用 tests/agent-integration/vitest.config.ts；现有 CI 的 Test 步骤仍执行根 pnpm test，因此新组自动进入 CI。
- tools 的默认 Vitest 匹配 src 下的两个迁回文件，继续由 Turbo 的 tools 测试任务执行。
- 跨包组直接执行，不借用 Runtime 测试缓存；测试使用离线响应、临时文件或注入执行器，不需要模型凭据。
- 迁移后的说明见 [Agent 集成测试](../../../tests/agent-integration/README.md)；当前测试索引和已有文档链接同步更新。

## 集中验证

| 验证范围 | 结果 |
| --- | --- |
| pnpm test:agent-integration | 8 文件、49 项通过 |
| tools 的 job-tools / tool-search | 2 文件、32 项通过 |
| tools、agent-runtime 类型检查 | 通过 |
| Server/Client 联合类型检查 | 通过 |
| 架构规则测试 | 57 项通过 |
| 全仓架构静态扫描 | 通过；104 处既有 SessionStore 调用，阶段例外 0 |
| 文档检查 | 478 个 Markdown 文件通过，包含迁移入口与验收记录 |
| 锁文件与安装 | frozen-lockfile 离线安装通过，无外部依赖版本升级 |
| 本次文件的历史引用批准、CI 命令和旧依赖扫描 | 通过；当前 packages/apps/tests/scripts、根清单及锁文件中无旧包引用，历史文档保留 |
| 差异及新增文件空白检查 | 通过 |

没有运行完整 pnpm test。工作区同时存在 Core 目录整理及 Skill/天气插件修改，本次不修改这些实现或为它们新增批准。早先全仓历史引用检查曾受这些并行修改影响；提交前重新检查的结果见下方。

## 提交前复核

- 按要求重新运行 pnpm check:retired-ui 和 pnpm check-docs：当前工作区两项均通过，历史引用检查零错误，文档检查覆盖 479 个 Markdown 文件。
- 提交范围包含本清理、测试迁移、配套配置与文档，以及 [旧飞书 MCP 入口删除](./2026-10-23-mcp-feishu-retirement.md)。共享文档只纳入本次测试路径和归属说明，不包含 Core 目录整理等并行改动。
- 使用独立暂存区组装提交；只包含本次改动的目录快照中，两项检查均通过：历史引用检查覆盖 4,065 个文件、729 条精确批准和 90 个删除路径，零错误；文档检查覆盖 477 个 Markdown 文件。提交差异空白检查通过。既有回归结果沿用本记录，不重复运行完整测试套件；推送后不等待 CI。
- 本地 main 另有不属于本任务、尚未推送的 Core 提交。本次以远端 main 为基础创建 codex/cleanup-unused-agent-entries 分支，仅推送此分支；不切换主工作区，不把其他并行提交一并推送。

## 交付边界

旧 swarm 的源码、包清单和配置已删除；本机忽略的 dist、node_modules 和缓存目录递归清理被执行工具策略阻止，它们不进入版本库，也不会在干净检出中恢复该包。
