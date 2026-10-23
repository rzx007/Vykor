# 旧飞书 MCP 入口删除验收

> 状态：当前清理记录；仅覆盖旧入口删除和现行文档引用清理。

## 实施范围

- 删除 apps/mcp-feishu 的唯一源码 src/index.ts。这个独立 stdio MCP 入口提供旧 send_feishu_message 工具，仍读取 settings.json 的 channels.feishu；没有包清单、构建、启动、安装或 CI 接入。
- README 项目结构不再列出旧入口；全仓检索未发现其他把它作为当前入口的文档。历史方案与交接记录保留原文，供追溯，不作为现行运行说明。
- 当前飞书渠道继续使用 [FeishuAdapter](../../../packages/channels/src/impl/feishu.ts)，推送继续使用 [FeishuPush](../../../packages/tools/src/channels/feishu-push.ts)，通过 [Node 默认工具注册表](../../../packages/agent-runtime/src/node/tools/default-tool-registry.ts) 和配置适配取得 channel-credentials.json 中的配置。
- 不改变现行飞书实现、工具注册、配置、依赖或 CI；不修改其他并行任务的代码。

## 集中验证

| 验证范围 | 命令 / 核对方法 | 结果 |
| --- | --- | --- |
| 飞书渠道、连接、凭据验证与注册 | pnpm --filter @vykor/channels exec vitest run src/impl/__test__/feishu.test.ts src/impl/__test__/feishu-connect.test.ts src/impl/__test__/feishu-verify.test.ts src/impl/__test__/feishu-registration.test.ts | 4 文件、59 项通过 |
| 飞书推送工具 | pnpm --filter @vykor/tools exec vitest run src/channels/__test__/feishu-push.test.ts | 1 文件、9 项通过 |
| 默认工具注册（包含 FeishuPush） | pnpm --filter @vykor/agent-runtime exec vitest run src/node/tools/default-tool-registry.test.ts | 1 文件、9 项通过 |
| 架构边界 | node scripts/architecture-boundaries.mjs | 通过；104 处既有 SessionStore 调用，阶段例外 0 |
| 文档 | pnpm check-docs | 479 个 Markdown 文件通过；链接、章节、源码路径、状态、入口和契约测试映射有效 |
| 旧入口与现行引用 | 全仓检索旧目录名和工具名；历史材料与本验收记录除外 | 旧目录不存在，现行源码、配置与文档无旧引用 |
| 改动范围 | 比对操作前后的文件 SHA-256 摘要 | 渠道、推送、导出、Node 注册和配置适配源码，以及根清单、锁文件、工作区配置和 CI 配置均未变化；README 仅删除旧目录行并调整树形连接符 |

本次相关回归共 6 文件、77 项通过，没有运行完整 pnpm test。工作区已有的 swarm 清理、Core 目录整理、Skill 及其他并行修改不纳入本验收；本次只删除旧入口、调整 README 并新增此记录。

## 提交前复核

本清理与 [swarm 退役及测试迁移](./2026-10-23-swarm-retirement-and-agent-tests.md) 一并交付。按要求重新运行 pnpm check:retired-ui 和 pnpm check-docs，当前工作区两项均通过，文档检查覆盖 479 个 Markdown 文件。以远端 main 为基础的独立提交快照复核也通过：历史引用检查零错误（4,065 个文件、729 条精确批准、90 个删除路径），文档检查覆盖 477 个 Markdown 文件，提交差异空白检查通过。仅推送 codex/cleanup-unused-agent-entries，避免带上本地 main 尚未推送的其他提交；保留主工作区，不重复运行全量测试，推送后不等待 CI。
