# P0–P13 最终复查：四项 P2 修复验收

> 状态：当前修复记录；仅覆盖最终复查的四项问题，不代替原分阶段验收。

## 范围与结果

| 问题 | 修复与验收标准 | 回归位置 |
| --- | --- | --- |
| Terminal 创建与关闭并发 | 关闭时同步停止创建准入，等待已接收的创建收尾，再清理会话；迟到的环境目标释放 lease，关闭后不启动 PTY；重复关闭复用同一结果 | terminal-node 的 local-terminal-provider / agent-terminal-host 测试 |
| Goal 结算失败后恢复 | Run 终态先按该 Run 将遗留 pending 尝试转为 unknown，并触发现有预算停止路径；恢复前再次核对，覆盖终态补账也失败的情况；不改动其他 Run 的进行中尝试 | Server 的 session-goal-service、Services 的 goal-transactions 测试 |
| 声明追踪遗漏 | 追踪箭头/函数表达式的公开签名及 async 隐含的 Promise 返回；继续忽略与公开签名无关的函数体局部注解，避免误报 | scripts/architecture-boundaries.test.mjs |
| 插件市场绕过 Protocol | 能力数据保留在 plugin-contracts；Protocol 拥有市场通信封装与解析；Client 经 Protocol 消费；HTTP 验证后调用应用服务，响应按允许字段映射，格式错误转为 Protocol 错误 | Protocol 的 plugin-marketplace、Server 的 marketplace routes、Client 市场与公开 API 测试 |

Terminal 和 Goal 两项是改造前已有的缺口，不归因为 P0–P13 新引入的问题。审查后另一个并行任务已完成 Client 市场类型引用、清单/锁文件及相应公开 API 基线修正；本次保留该结果，在其上补充通信封装、解析和映射，不重复修改这些基线。

本次实施期间 main 从 db96047b 更新至 4347a60a；并行提交已保留。按 Run 补账同时覆盖 sqlite 与 memory 会话，启动恢复仍只扫描持久记录。

## 集中验证

新增回归首先在旧实现上复现失败：Terminal 两项、Goal 结算失败恢复、声明追踪和市场未知字段拒绝。随后集中执行以下范围，没有运行完整 pnpm test。

| 范围 / 命令 | 结果 |
| --- | --- |
| terminal-node：local-terminal-provider / agent-terminal-host | 2 文件，23 项通过 |
| Server：session-goal-service / session-goal-queue / session-goal-dispatch-events / goal-model-attempt-service / marketplace routes | 5 文件，89 项通过 |
| Services：goal-transactions / goal-usage / session-goals / temporary-control-records | 分批验证，4 文件共 54 项通过；补齐 memory 回归后只重跑受影响的前者与临时记录组，共 30 项 |
| Protocol：plugin-marketplace | 15 项通过 |
| Client：plugin-marketplace / public-api | 5 项通过 |
| node --test scripts/architecture-boundaries.test.mjs | 57 项通过 |
| terminal-node / Services / Protocol / Client / Server 类型检查 | 5 包通过 |
| node scripts/architecture-boundaries.mjs | 通过；104 处既有 SessionStore 调用，阶段例外 0 |
| pnpm check-docs | 475 个 Markdown 文件通过 |
| pnpm exec tsc -p tests/client-public-api/tsconfig.json | 通过 |
| pnpm check:clean-slate / git diff --check | 通过 |

## 范围限制

- 本次新增文件均为正式实现、正式回归或本验收记录，无一次性测试文件。
- 未改变数据库 schema、预算计算公式、模型重试策略或 Node/Kernel 依赖方向；没有扩大架构例外。
- 本次定向验证在 Windows 执行，不声称 Linux/macOS 原生终端测试结果；未重复构建独立 SDK tarball。
- 后续按用户指令单独提交并推送这四项修复、正式回归和配套验收；其他并行的桌面、技能管理和插件市场文档修改不纳入本修复提交。

## main 推送后的 CI 修复

- [3a72d195 的 CI](https://github.com/rzx007/Vykor/actions/runs/39792876003) 在架构检查中的历史引用核对失败：Protocol 新增市场出口使原有历史解析导出的批准位置从 29 行移到 30 行。只校正精确行号，批准文本、理由和引用总数不变。
- [上一轮 CI](https://github.com/rzx007/Vykor/actions/runs/39791520063) 的插件作者分发测试已发现示例升级到 1.2.2 后，Skill 附带副本仍为 1.2.1。本次同步副本的 package、锁文件根条目和插件定义版本；保留模板自己的功能范围。
- 正式回归继续逐字核对两份分发的源码和包文件，新增副本内 package、锁文件及插件定义版本一致性断言。新增断言引起的历史测试行号从 77 校正到 84，不增加豁免。
- 本地仅验证历史引用检查及其测试、插件作者分发单文件、文档和提交钩子；不重跑完整测试套件。推送后的完整 CI 作为最终远端验收。
- 集中验证结果：历史引用检查 729 条、0 错误；精确批准门禁测试 1 项、插件作者分发 8 项通过；文档检查 475 文件及本次差异检查通过。
