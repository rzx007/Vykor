# 剩余 Packages 目录整理计划

**目标：** 将尚未整理的 23 个有效包按同一规范整理，补齐职责说明和测试目录。

**方案：** 只迁移文件并同步引用，不修改业务行为或包的公开导出名称。已有清晰分类的包沿用现有结构；职责单一的小包保留紧凑源码目录。通过已有测试、模块内容对比和包入口检查验证迁移。

**依据：** [AGENTS.md](../../../AGENTS.md) 的“目录、测试与说明”，以及本次要求一起处理剩余包。

## 范围与目录

| 包 | 整理方式 |
| --- | --- |
| agent-contracts | 按 execution、conversation、model、tools、policy 分类；统一 src 与原 test 中的测试 |
| api | 保留模型目录和提供方入口，按 tools、media、requests、streaming 分类提供方的辅助代码 |
| auth | 按 credentials、mcp、channels 分类 |
| channels | 保留 bus、core；原 impl 按 adapters/feishu、adapters/http、adapters/stdio 分类 |
| coordinator | 保留 definitions、teams、workflow；模式、提示词和通知代码归 runtime |
| mcp | 按 connections、resources、oauth 分类 |
| sandbox | 按 policy、configuration、environment、process 分类；端到端用例归 __test__/e2e |
| terminal-node | 按 host、providers、output 分类 |
| domain-contracts、execution-node | 保留领域数据和进程执行的现有分类，补齐 README 并统一测试位置 |
| commands、environment、hooks、jobs、json-data、memory、output-styles、permissions、personalization、prompts、skills、terminal、themes | 保持职责单一的小包结构；统一测试并提供源码、子分类和包根导航 |

没有 package.json 和源码文件的历史 swarm 目录不在有效包范围中，不创建新入口。

## 执行与验证

- [x] 记录起始提交、已有工作区改动、文件内容和迁移映射，检查目标路径冲突。
- [x] 移动实现与测试，同步导入、公开入口目标、配置、文档和旧引用清单。
- [x] 同步 agent-contracts、sandbox 及全局端到端测试配置，确保迁移后的原有测试仍会被发现。
- [x] 按不重叠的包分组补齐 README，说明用途、文件、入口、关键步骤、状态归属与新增代码位置。
- [x] 核对模块内容、相对引用、公开导出名称、测试数量、夹具内容和 README 链接。
- [x] 运行这 23 个包的测试及全仓 `pnpm check-types`，补跑实际受影响的消费方测试。
- [x] 运行 `pnpm check:architecture`、`pnpm check:retired-ui`、`pnpm check-docs` 和包含新增文件的差异检查。
- [x] 更新实际结果。本次整理和验证完成后交付，提交与推送按用户后续指示执行。

## 检查命令

```powershell
pnpm --filter @vykor/agent-contracts --filter @vykor/api --filter @vykor/auth --filter @vykor/channels --filter @vykor/commands --filter @vykor/coordinator --filter @vykor/domain-contracts --filter @vykor/environment --filter @vykor/execution-node --filter @vykor/hooks --filter @vykor/jobs --filter @vykor/json-data --filter @vykor/mcp --filter @vykor/memory --filter @vykor/output-styles --filter @vykor/permissions --filter @vykor/personalization --filter @vykor/prompts --filter @vykor/sandbox --filter @vykor/skills --filter @vykor/terminal --filter @vykor/terminal-node --filter @vykor/themes --workspace-concurrency=2 -r test
pnpm check-types
pnpm check:architecture
pnpm check:retired-ui
pnpm check-docs
git diff --check
```

## 结果

起始提交为 `a34b3f31b4bde05a41a3caa43de0ddbb9df39208`。本次迁移 64 个实现文件和 81 个测试文件，保持 91 个测试文件的总量；补齐或更新 97 份 README，核对 73 个源码分类和 479 个相对链接。283 个包内源码与配置文件及 3 个外部源码文件经过内容对比，除迁移路径和明确的测试发现配置外，实现逻辑未变；291 处相对引用仍指向原模块，公开导出名称未变，模型数据文件内容未变。

`agent-contracts` 的原测试配置只包含 `test/`，迁移时改为覆盖 `src/` 下的全部测试，原来未被发现的两个源码测试文件也已执行。检查器测试中嵌套的示例源码和导出目标同步到新目录，保留原断言。旧引用清单只迁移两个既有测试条目的路径，732 个精确条目和 90 个移除路径的检查范围未变。

| 检查 | 结果 |
| --- | --- |
| 23 个包的测试 | 1,257 项通过、3 项原有跳过；terminal 当前没有测试，按已有脚本允许空测试 |
| execution-node 单独重跑 | 7 个文件、94 项通过；批量运行时断言通过，但测试进程通信超时，单独重跑未复现 |
| core、protocol 消费方回归 | 53 个文件、619 项通过 |
| `pnpm check-types` | 72 个任务成功，另含 server-client 类型检查通过 |
| `pnpm check:architecture` | 66 项检查器测试、4 项 Client 公开接口测试、架构边界、clean-slate 和旧引用检查通过 |
| `pnpm check:retired-ui` | 通过，732 个精确引用、90 个移除路径保持有效 |
| `pnpm check-docs` | 通过；另对 97 份包 README 独立验证分类覆盖和相对链接 |
| sandbox 的 `e2e:srt` 命令 | 能发现迁移后的测试；本机不支持 SRT，按原规则跳过 1 项 |
| 含新增文件的差异检查 | 通过，使用临时 Git 索引，未暂存到主索引 |

额外运行的真实 WSL 集成测试有两项失败：文件搜索与后台进程场景超时，PTY 场景存在退出状态或中断后输出问题。在临时目录解出起始提交的原始源码，使用相同依赖复跑，两项相同场景仍失败；这次目录迁移没有修改相关实现和断言，保留这些既有问题，不将其记为检查通过。

桌面界面、agent-runtime README 及其他并行工作不属于本次改动。本次未提交或推送。
