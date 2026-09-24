# 任务 3 报告：常用工具反馈

## 结果

File Read/Write/Edit、Shell、BackgroundShellCreate、WebSearch/WebFetch 和 Job 工具返回已有的 `executionState`、`failureKind`、`recoveryHint`、`compactSummary` 字段。工具正文与错误输出仍在 `content` 中；摘要只记录动作、目标和已知结果，不复制命令、网页正文、文件正文或任务输出。未加自动重试。

Shell 依据 executor 的 status、failureKind 和 exitCode 分类：确定的非零退出为 `completed/command`；超时和中断为 `unknown`；执行前识别的语法错误为 `not_started/invalid_input`；策略拒绝为 `not_started/policy`。stderr 非空本身不决定成功。WebFetch 的 401/403 仅凭 HTTP 状态无法判定认证还是策略，所以归 `provider`，并建议检查访问条件；429/503 只建议稍后检查。空搜索仍是正常完成。文件策略阻止标明未开始；Write/Edit 写入异常保留 `unknown`，提示先检查实际文件状态。JobWait 到期仍是成功观察，不建议重启任务。

JobRead、JobWait 的受控摘要记录宿主快照中的 jobId、status、cursor 和已知 exitCode，包括 `null`；多任务只保留最近 8 项，并明确省略数量。BackgroundShellCreate 与 Shell 自动转后台的摘要包含真实 jobId，不含命令正文。附件 Read 包装为附件读提供同样的事实摘要，普通路径仍直接转发原 Read 结果。

## 可信 Read 接线

新增 `QueryEngineOptions.trustedToolOverrides?: ReadonlySet<string>`。默认运行时只传递 `applyConfiguredTools` 已确认替换内置工具的宿主名单。QueryEngine 仅接受内置来源的成功摘要，或名单内且当前注册来源仍为 `agent` 的覆盖工具摘要。普通 agent 覆盖和后续插件替换即使使用同名 Read，也不保留自由成功摘要；错误摘要仍由宿主根据结构化分类生成。未增加权限策略，也未修改 microCompact。

## RED / GREEN 记录

- RED：新 Web 空搜索、HTTP 403、文件 Read、附件 Read 用例先失败，原因均为缺少结构化反馈字段；tools 3 个失败、server 1 个失败。沙箱内读取已安装 Vitest 因 EPERM 失败，随后按要求提权运行本地 `node .../vitest.mjs` 才得到有效 RED。
- GREEN：实现后，任务列出的工具定向测试加新 Write 测试为 7 文件 98/98；server 附件 Read 为 1/1。Shell 旧精确对象断言因新增字段调整，保留对原正文和错误的断言。
- 信任负例：新增插件替换已受信任名称的用例，先 RED（插件自由摘要被保留），限制当前来源后 GREEN。核心集成测试 61/61；默认运行时测试 34/34，其中包含跨层可信 Read 正例。
- TypeScript：core、tools、agent-runtime、server 的 `tsc -p tsconfig.json --noEmit` 均 exit 0。
- 任务 0 scripted：`node node_modules/vitest/vitest.mjs run --config tests/agent-behavior/vitest.config.ts tests/agent-behavior/run.test.ts tests/agent-behavior/suite.test.ts` 为 41/41、exit 0；这是固定脚本链路检查，不代表真实模型完成率。

## 限制

旧插件结果仍走 core 保守默认，不根据返回文本推断执行成功。HTTP 401/403 的具体限制类型仍依赖 provider 提供明确语义。Job 摘要仅为观察时快照，不能代表用户目标完成；受控摘要最多 1,000 字符，完整正文仍在普通结果中。未进行 live 模型评测。
