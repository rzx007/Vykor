# 模型网络重试：补完与整体审核记录

> 状态：当前验证记录，2026-09-26；剩余实现、自动验收和整体审核修复已完成，验证边界见下文。

关联：[设计文档](../../model-network-retry-design.md)、[执行计划](./2026-09-25-model-network-retry.md)。

## 本轮补完范围

- CLI：普通终端重试提示、最终 JSON 有效正文、流式 JSON 生成归属与失效片段标识。
- TUI：有效正文过滤、当前运行重试倒计时、用量不完整提示，保留停止动作。
- Desktop：补上真实正文路径的 superseded 过滤；倒计时无需新快照也更新；展示已知用量及不完整说明。
- 端到端：真实 QueryEngine → FrameworkAgentRun → SessionTranscriptProjection/SessionStore → SQLite 重载和客户端 reducer；覆盖失败输出替换、长度受限、工具不重复、失败/取消收尾和投影失败不触发模型重试。
- Desktop 合并快照：一个窗口内失效、重试、完成，仅收到最终状态也能过滤旧内容、清除等待并保留用量完整性。

## 第一轮实际检查（整体审核修复前）

| 范围 | 实际结果 |
|---|---|
| core 策略、引擎、压缩及请求配置 | 7 文件，141 测试通过 |
| API 错误及三个适配器 | 5 文件，70 测试通过 |
| agent-runtime 事件、结果、记忆 | 3 文件，21 测试通过 |
| server 端到端、历史、投影、看门狗 | 7 文件，90 测试通过 |
| client selector、reducer、sync、握手、公共 API | 5 文件，41 测试通过 |
| Desktop 过滤、提示、计时器、合并快照 | 5 文件，15 测试通过 |
| CLI print-session、真实 daemon 集成、renderer | 3 文件，24 测试通过 |
| TUI transcript、Session | 2 文件，13 测试通过；有 React act 警告 |
| 七个包及 Desktop/CLI/TUI TypeScript | 通过 |
| 边界检查器自身测试 | 31 测试通过 |
| 实际架构扫描 | 未通过：旧式 SessionStore 调用数从 123 增到 126，纳入修复 |
| 文档检查 | 修正文档状态分类后通过 |

执行使用工作区已安装的 Vitest/TypeScript/Bun。沙箱读取 node_modules 报 EPERM 后，改用获准的本地测试执行权限；没有重新安装依赖或调用真实计费模型。

## 独立整体审核发现

| 编号 | 问题 | 要求的修复与证据 |
|---|---|---|
| R1 | 请求中取消被运行层提前截断，尝试结算未落库 | 取消前允许结算，不允许继续正文/工具；真实在途取消测试 |
| R2 | 未收到 usage 伪造为 0，断流前已知快照丢失 | 区分缺失与合法零；及时发布累计快照；三适配器回归 |
| R3 | 压缩消耗只记内存，不进入当前运行持久记录 | 执行事件通路结算；独立 compact 不伪造 Run；压缩测试 |
| R4 | Desktop 用量小计仅显示最后请求 | 统一已知消耗累计来源，保留不完整状态，防止双重计数 |
| R5 | Codex HTTP 错误丢 Retry-After、quota code、request id | 安全保留决策字段；quota 不重试，Retry-After 有效 |
| G1 | 新增三个事务调用使架构门禁失败 | 收敛实际事务入口，不提高基线，不通过调用语法规避检查 |

这些问题在初轮功能测试通过后由独立审核发现，不能以初轮全绿替代修复后的回归和复审。

## 验证范围与未执行项目

- 使用模拟模型故障、真实运行/持久层、真实 CLI daemon 流和组件渲染测试；不消耗真实模型额度。
- 未执行完整全仓测试；按改动风险运行相关包/文件和跨层检查。
- 未在宿主实际 Desktop/TUI 窗口进行人工点击观察；倒计时、输出替换、停止链路和合并窗口有自动验证，但不等于人工观感验收。
- 未提交、推送、合并或发布；保留用户已有工作区修改。

## 最终修复与复审结果

R1～R5 已修复。原审核智能体完成定向复审：R1/R2/R4/R5 通过；R3 追加发现自动压缩 client 保留旧执行上下文，随后在自动压缩 finally 中恢复同一已解析 client/model 的无 Run 版本。新增同一引擎先运行再手动压缩的回归测试通过，最后的定向检查确认闭包残留已消除，未发现新问题。

G1 通过合并真实模型生命周期事务入口解决，架构扫描为 `sessionStoreFlatCalls: 123`，没有修改基线。额外发现并修复 clean-slate 检查器仍要求协议 4 的遗漏：改为严格要求 5，检查器 4 项测试及实际扫描通过。

修复后最终定向测试结果（不同时间只对实际修改部分复测，不重复计算同一用例）：

| 范围 | 通过数 |
|---|---:|
| API 错误、超时、三个适配器 | 74 |
| core 策略、重试、压缩、输出预算及工具回归 | 144 |
| runtime 事件、取消结算、记忆 | 22 |
| server 端到端、投影、历史、看门狗 | 92 |
| client 同步、显示、握手与公共接口 | 41 |
| protocol metadata 与版本 | 17 |
| services 记忆、结算注册、运行记录、增量输出 | 36 |
| CLI 单元与真实 daemon 流 | 24 |
| TUI transcript 与渲染 | 13 |
| Desktop 提示、过滤、倒计时、合并快照 | 15 |

主要执行方式：在相应包目录运行 `node ../../node_modules/vitest/vitest.mjs run <上述定向文件>`；Desktop 使用根目录 Vitest 加 `--config apps/desktop/vitest.config.ts`；TUI 使用 `bun test src/hooks/transcript.test.ts src/routes/session/Session.test.tsx`。覆盖文件见[契约测试索引](../../contract-test-index.md)。

最终类型检查：core、api、agent-runtime、protocol、services、server、client，以及 CLI/TUI、Desktop 的 node/web 配置全部通过（TypeScript `--noEmit`）。客户端公共 API 编译契约通过；边界检查器 31 项测试、clean-slate 检查器 4 项测试及实际架构扫描通过。TUI 的 React act 警告仍在，测试无失败。

记录的实现取舍：

1. 继续原有未提交工作区，不切换或覆盖已有实现；便于保留用户改动，代价是后续提交需自行区分原有工作。
2. 持久数字及完整性统一由 model.attempt.finished 原子更新，usage.updated 保留给观察者。旧持久元数据保留，但仅重放历史 usage.updated 不新增计费；自定义持久消费者须按 SDK 文档接入结算事件。
3. 本轮以可控故障、真实持久链路及组件测试完成自动验收，没有将宿主人工观察和真实网络计费试验冒充完成。发布前如需人工观感确认，仍应执行该项。
