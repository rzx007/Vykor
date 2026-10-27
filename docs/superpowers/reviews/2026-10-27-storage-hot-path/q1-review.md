# Q1 独立审查

结论：未发现实质问题，可以将本次 Q1 单独提交。

## 范围和身份

- 审查日期：2026-10-27。
- 基线及审查时 HEAD：`c0bdb5dbfbda8a6e02be5fbfdc6e0c9ccd4191cc`。
- 工作目录：`C:/Users/ruanz/.codex/worktrees/storage-hot-path-q1-q2/OpenHarness-ts`；分支：`codex/storage-hot-path-q1-q2`。
- 范围为 [Q1 计划](../../plans/2026-10-27-storage-hot-path-optimization-plan.md) 指定的两个生产文件、两个测试文件和各自 README，共 6 文件，新增 57 行、删除 8 行。实际 `git diff --unified=8 c0bdb5db -- <六文件>` 与 [归档补丁](./q1-review.diff) 在统一换行后完全一致。
- 本次只读审查生产代码及必要调用上下文，按涉及清理删除和回执保护的较高风险检查；安全、接口边界及异常组合均顺序审查，没有派生代理。另行准备的 Q2 基准、实验脚本和归档属性不属于本次代码结论。

## 规格符合性

| Q1 要求 | 源码与测试依据 | 结论 |
| --- | --- | --- |
| 状态检查使用现有摘要接口 | `packages/server/src/application/session/execution/tool-operation-service.ts:77` 和 `:127` 改为 `getSummary()`。既有 `packages/services/src/tool-operations/tool-operation-repository.ts:26`、`:238` 从同一记录生成有限字段的新对象，包含原判断所需的 `state`，不复制正文。 | 符合 |
| 每个操作分别解除失败保护 | `tool-operation-service.ts:75`、`:77`、`:123`、`:126` 仍只处理当前 operation ID；只有 `confirmed/not_applied` 才删除对应集合项。`__test__/tool-operation-service.test.ts:47` 用两份失败回执逐项迟到结算或人工核对，第一份解除后仍阻止派发。 | 符合 |
| 每次保护判断只读一次元数据，以目标树 ID 集合筛选 | `packages/server/src/application/maintenance/cleanup-settings.ts:97` 建立 `Set`，`:98` 只调用一次无参数 `listSafetyStates()`。既有 Repository `:216` 只投影 ID、会话、Run、kind、state。 | 符合 |
| 四种未决状态保护整树，删除前复查 | `cleanup-settings.ts:85` 收集后代；`:98` 保留 `prepared/authorized/dispatching/unknown`；`:60` 在删除前重新计算树并检查，至 `:63` 调用共享删除入口之前没有新增异步间隔。`__test__/cleanup-settings.test.ts:23` 覆盖根、子、孙与四状态的 12 种组合；`:42` 覆盖预览后兄弟后代新增未决操作。 | 符合 |
| 真实 SQLite、大正文、禁止完整读取、完整结果仍可读取 | Service 夹具在 `__test__/tool-operation-service.test.ts:14` 建立 SQLite 并取得真实 owner；`:37`、`:47` 使用 1 MiB 结果并使完整 `get()` 抛错，`:45` 恢复完整读取后核对保存结果。清理用例 `:28`、`:48` 禁止完整 `list()`，`:34` 核对一次元数据读取。 | 符合 |
| 保留回执、迟到结果、owner、审计和复制语义 | 从源码差异和上下文看，这些校验及 Repository 的完整保存、回执比较、返回记录复制均未改动。`settle/reconcile` 仍走原事务和 owner 检查；清理仍调用原共享删除入口。未新增接口、依赖、配置、缓存或索引。 | 符合 |
| 同步本域说明 | `packages/server/src/application/maintenance/README.md:11` 和 `packages/server/src/application/session/execution/README.md:58` 描述新读取边界，没有扩大性能承诺。 | 符合 |

## 实质发现

无。严重度为高、中、低的实质发现均为 0；无提交阻塞项、无额外文档欠项。

额外从异常回滚、同树其他操作仍失败、预览后新增操作、无关会话树及大结果组合检查本次差异，没有发现新增的保护遗漏或可变正文共享。

## 验证证据及限制

本审查没有重复运行测试、构建、类型检查或全仓扫描。以下为复用实施阶段证据；本次已读回日志与 [validation.json](./validation.json)，并核对上述六文件仍与审查补丁一致：

- [RED 日志](./q1-red-1.txt)：2 文件，16 项失败、18 项通过。12 个四状态树保护用例因完整 `list()` 抛错失败；执行前复查用例未得到预期跳过结果；3 个 Service 用例因完整 `get()` 抛错失败，覆盖要求对应的旧实现路径。
- [GREEN 回归](./q1-green-1.txt)：计划指定的 Server 四文件共 48 项全部通过。
- [首次类型检查](./q1-green-2.txt) 因本检出目录缺少 `@vykor/agent-runtime` 生成产物失败；[补建记录](./setup-runtime-build.txt) 后，[Server 类型检查复跑](./q1-green-2-rerun-2.txt) 退出码为 0。该先失败属于依赖产物准备问题。
- [架构门禁](./q1-green-3.txt) 通过，103 个既有扁平调用、0 项例外；[旧 UI 检查](./q1-green-4.txt)、[文档检查](./q1-green-5.txt) 和 [diff 空白检查](./q1-green-6.txt) 在验证清单中均为退出码 0。

Q1 的结论仅为消除这些状态读取的无用正文复制、保留既有行为；不据此宣称减少启动时间、常驻内存或全部历史遍历。本报告自身由审查者新增，最终提交前的文档检查由主执行流程负责。

## 完成清单

1. 已完成：Q1 六文件和必要上下游源码的独立审查，未发现实质问题。
2. 已完成：读回复用验证日志，确认当前六文件补丁与归档一致。
3. 已完成：只写入本审查报告；未改动生产代码、测试、索引、HEAD 或分支。
4. 交由主执行流程：将 Q1 作为单独提交保存；本审查未执行提交或推送。
