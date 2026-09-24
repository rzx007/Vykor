# 跨任务行为评测基线

> 状态：当前。本地脚本基线可运行；真实模型评测尚未授权，不能据此宣称模型能力提升。

这套评测固定 12 个场景，每个场景运行 3 次。默认 `scripted` 模式使用本地脚本 client 和临时目录，不发外部模型请求。它检查 Agent 的工具链路、权限拒绝、预算取消、状态记录和自动压缩。脚本走通不代表真实模型会作出同样判断，也不代表能力已经提升。

在仓库根目录运行：

```powershell
pnpm exec vitest run --config tests/agent-behavior/vitest.config.ts tests/agent-behavior/run.test.ts
$previousMode=$env:VYKOR_EVAL_MODE
$previousOut=$env:VYKOR_EVAL_OUT
try {
  $env:VYKOR_EVAL_MODE='scripted'
  $env:VYKOR_EVAL_OUT=Join-Path $env:TEMP 'vykor-agent-baseline.json'
  pnpm exec vitest run --config tests/agent-behavior/vitest.config.ts tests/agent-behavior/suite.test.ts
} finally {
  if ($null -eq $previousMode) { Remove-Item Env:VYKOR_EVAL_MODE -ErrorAction SilentlyContinue } else { $env:VYKOR_EVAL_MODE=$previousMode }
  if ($null -eq $previousOut) { Remove-Item Env:VYKOR_EVAL_OUT -ErrorAction SilentlyContinue } else { $env:VYKOR_EVAL_OUT=$previousOut }
}
```

结果 JSON 写在系统临时目录，逐次保留 `passed`、`failed`、`timed_out`、`cancelled`、`budget_cancelled`、`pending_review`、`not_run`。套件有 36 个独立测试，验收失败会保存结果并使 Vitest 退出失败。每次运行记录代码提交、fixture 版本、题目文本 SHA-256、模型及请求上限、权限配置、工具调用数、请求数和耗时。真实 token 用量只在 client 提供 usage 时记录；缺失时保持未知。

开发集是 C1、C2、R1、R3、F1、F3、J1、J3；C3、R2、F2、J2 留作验收。R2 和 F2 先检查是否读取足够的来源或图片，再标记 `pending_review`，由人工根据完整轨迹判断结论和不确定性表达。不能只凭最终回答的关键词判定内容正确。结果中的 `prematureStop` 和 `redundantVerification` 也是人工复核项，未复核时不赋值。

J3 先让 Agent 完成 A，再通过公开 `loadHistory` 加入中性短段材料，最后运行 B。材料没有声称 A 或 B 已完成。固定 50,000 token 上下文容量下，运行时阈值为 17,000 token；摘要请求、压缩事件和随后继续请求都必须出现，否则该样本失败。每个样本单独创建 Agent、设置和临时配置目录；MCP、插件、hooks、memory、terminal、后台 shell、子环境、workflow 和 schedules 均关闭。场景工具由宿主上限约束；R3 的拒绝来自真实权限检查，受限工具执行次数必须为零。

`VYKOR_EVAL_MODE=live` 目前一律拒绝启动。它要求通过 `VYKOR_EVAL_CONFIG` 提供 provider、model、运行次数、获批美元预算、adapter 内部重试上限和每次请求的保守价格上限。当前没有获批费用和可核实的供应商上限，因此不发请求。以后接入 live 时还须让摘要请求共用预算、明确未知 usage、记录 adapter 重试元数据，并在无法保守估价时停止后续请求。`maxRequests` 只统计 `streamMessage` 调用，不代表底层 HTTP 次数；已发出的调用也可能产生费用。

比较两个代码版本时，在各自独立检出目录使用同一场景 fixture、模型、参数、权限及故障脚本；每题保留 3 次全部结果。先比较完成次数和安全边界，再人工检查轨迹。失败早停造成的低耗时或低 token 数不算效率改善。

## 请求级工具定义测量

`toolCatalogRequests` 记录每次真正传给 provider 的工具定义数量、序列化字符数和 `heuristic_v1`（字符数 / 4 向上取整）估算。顺序按实际请求保留；不记录工具调用参数。摘要请求不带工具时记零，不把空数组算作定义开销。实际 usage 单列且缺失时不填零；工具占比若有值，是“估算定义 token / client 报告的输入 token”，不是精确归因或节省费用。

```powershell
pnpm exec vitest run --config tests/agent-behavior/vitest.config.ts tests/agent-behavior/tool-catalog.test.ts
```

2026-09-25 的合成目录回归结果：

| 注册定义数 | 权限过滤后实际送出 | 序列化字符 | 估算 token |
| ---: | ---: | ---: | ---: |
| 4 | 3 | 481 | 121 |
| 8 | 7 | 1,121 | 281 |
| 40 | 39 | 6,270 | 1,568 |
| 120 | 119 | 19,169 | 4,793 |

每组排除一个禁止工具，任务所需工具只有两个。脚本注入的 usage 只验证统计公式，不是真实模型输入；脚本选错工具也只验证计数，不证明模型的选错率。重复目录和压缩前后请求用于检查统计稳定性及每轮变化。

**结论：阶段 C 暂不启动。** 尚无真实已授权目录和至少三个受影响任务的证据。真实工具选择质量、搜索额外往返、真实费用均未测。阶段 A 的执行事实和压缩修复可以独立保留；阶段 B 的提示词调整也等待获批的真实模型对照评测。
