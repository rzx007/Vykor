# 上下文占用报告

把系统提示、消息历史和工具参数定义的占用情况分组汇总，生成上下文使用快照、文字报告和调整建议。这里的 token 数是估算值，实际请求用量由 `engine/usage/` 统计。

| 文件 | 用途 |
| --- | --- |
| `index.ts` | `@vykor/core/context-budget` 公开入口 |
| `types.ts` | 报告输入、分类、快照与建议类型 |
| `messages-to-segments.ts` | 将消息转成可逐项统计的记录 |
| `tool-segments.ts` | 将工具参数定义转成统计记录 |
| `assemble.ts` | `assembleContextUsageSnapshot()` 汇总占用并计算使用比例 |
| `tips.ts` | 根据占用比例、模型切换等条件生成建议 |
| `format-report.ts` | 将快照转换为可展示的文字报告 |
| `__test__/` | 分类统计、建议和报告格式测试 |

调用方先准备消息与工具的统计记录，再传给汇总函数，获得快照并选择生成报告。函数根据传入数据计算结果，本目录不保存会话状态，也不直接修改历史。

新增占用分类、报告或建议规则放在这里；压缩消息的实际处理放在 `../engine/compaction/`，测试放在同层 `__test__/`。
