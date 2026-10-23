# 运行后的自动审查

根据运行产生的 Git 变化决定是否启动审查，并规范审查结果。

## 入口与流程

策略模块判断是否需要审查；Git 检查器收集变化；`SessionAutoReviewService` 协调审查并解析结果，供会话运行流程使用。

## 状态归属

Git 保存实际文件变化；审查过程通过传入的会话与执行依赖管理，解析结果返回调用方。

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
