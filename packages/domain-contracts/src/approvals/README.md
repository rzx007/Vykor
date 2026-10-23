# 审批与自动评审记录

定义工具权限审批过程的记录，以及一次运行结束后自动评审的状态数据。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/approvals` 公开入口 |
| [records.ts](records.ts) | 权限审批的开始、结束和判定结果记录 |
| [auto-review.ts](auto-review.ts) | 自动评审模式、风险、状态、原因及只读解析函数 |

自动评审内容也可从 `@vykor/domain-contracts/approvals/auto-review` 导入。消费方调用 `readAutoReviewRunMetadata` 校验已保存数据的版本、枚举和字段范围，非法数据返回 `undefined`。读取不会发起评审或改变审批结果。

审批请求、评审任务和运行元数据由消费方保存，本目录不调用模型或做出授权决定。新增记录定义与只读校验放本目录，测试建议放同层 `__test__/`。
