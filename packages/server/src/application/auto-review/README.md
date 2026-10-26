# 运行后的自动审查

根据运行产生的 Git 变化决定是否启动审查，并规范审查结果。

## 入口与流程

策略模块判断是否需要审查；Git 检查器收集变化；`SessionAutoReviewService` 为本次系统子 Agent 提供输出合同，子 Agent 通过内部 `SubmitResult` 提交报告。系统子 Agent 没有普通工具，patch 继续作为敏感初始输入传入。

合同数据沿用 `version`、`verdict`、`summary`、`findings`。格式检查后，宿主继续核对大小、文件路径、长度和结论一致性。完整报告使用交付状态 `done`，未完成报告使用 `partial`；合法的 `fail` 或 `partial` 报告也能通过核验。服务只消费真实回执中已通过格式检查和宿主核验的 `data`，普通文本 JSON 不能取得通过状态。

## 状态归属

Git 保存实际文件变化；Kernel 返回真实交付回执，服务把有界的审查摘要写入父 Run 和更新事件。报告核验通过表示格式和引用符合约束，实际评审结论仍由 `verdict` 决定；截断、抢占和超时继续保留原有处理。审查不改变父任务 Goal。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [auto-review-policy.ts](./auto-review-policy.ts) | `AutoReviewChangeFile`、`AutoReviewChangeSet`、`AutoReviewRiskDecision`、`classifyAutoReviewRisk` |
| [auto-review-result.ts](./auto-review-result.ts) | `AUTO_REVIEW_RESULT_MAX_BYTES`、`AUTO_REVIEW_MAX_FINDINGS`、`AutoReviewFinding`、`AutoReviewResult` 等 |
| [git-change-parsing.ts](./git-change-parsing.ts) | `GIT_PATCH_LIMIT_BYTES`、`StatusEntry`、`RepoState`、`buildDigest` 等 |
| [git-run-change-inspector.ts](./git-run-change-inspector.ts) | `GitRunResult`、`GitExecutor`、`GitDirtyEntry`、`GitRunBaseline` 等 |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [session-auto-review-service.ts](./session-auto-review-service.ts) | `AUTO_REVIEW_EVENT_TYPE`、`AutoReviewSessionPort`、`AutoReviewEventPublisherPort`、`SessionAutoReviewServiceOptions` 等 |

## 测试与维护

变化解析、审查策略与结果格式放在这里，运行何时触发审查由 session/execution 处理。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
