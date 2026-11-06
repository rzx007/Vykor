# Vykor 跨会话进度观察实施计划

> 使用 subagent-driven-development 逐任务执行。用复选框记录验收结果。

**目标**　让用户在普通提示中授权当前 Run 查看另一条会话的指定 Run。

**实现路径**　普通提示入口把首行指令交给运行接纳。接纳时固定目标，执行时按需提供宿主工具。工具读取现有记录并使用现有事件流等待。

**技术栈**　TypeScript、Hono、SQLite、Vitest。

## 任务一　接纳与授权

修改普通提示路由、运行接纳、队列提升和输入元数据校验。在 `packages/server/src/application/session/execution/session-observation-grant.ts` 集中放首行解析、授权读取和目标选择。复用渠道表与会话创建事件检查身份，相关查询分别留在现有 Repository。

- [x] 先写路由或接纳测试。向 `POST /sessions/:id/prompts` 发送首行指令，断言新 Run 的 `sessionObservationGrant` 记录固定目标。再提交元数据伪造、steer 和重复请求，分别断言拒绝或仍使用原 Run。
- [x] 运行 `pnpm --filter @vykor/server test session-observation`，确认因功能缺失失败。
- [x] 增加宿主保留字段校验、HTTP 指令解析和只在新排队 Run 写入时创建的授权。使用 `readSessionObservationGrant(run)` 统一读授权，用它拒绝队列提升。一般用户请求的元数据校验仍发生在写入之前。
- [x] 运行定向测试。补查不存在、子会话、临时会话和实际渠道绑定的拒绝路径。

## 任务二　读取与短等待

新增 `packages/server/src/application/session/execution/session-observation-tool.ts`，测试留在该目录的 `__test__/`。在 `session-run-executor.ts` 使用现有运行内工具贡献，在 daemon 装配处传入事件服务和记录读取入口。

- [x] 先写测试。用真实记录和事件服务检查运行完成、直接的审批/提问、目标后来开新 Run、同 ID 重建、取消与超时。断言观察结束后订阅数归零。
- [x] 运行 `pnpm --filter @vykor/server test session-observation`，确认因功能缺失失败。
- [x] 工具将超时限制在 30 秒和调用截止时间之内。先记序号，再读取授权和目标快照。订阅唤醒后重新读取，同一次调用始终使用固定目标 Run。超时再读一次，清理订阅和定时器。
- [x] 通过现有 `AgentRunContribution` 仅给获授权的 Run 提供 `SessionObserve`，并保留原有 Goal 工具。

## 任务三　真实入口与验收

在 server 的 HTTP 测试目录加一条脚本化模型用例，使用真实普通提示入口与 daemon 工具执行路径。更新文档导航、用户操作说明和运行目录 README。

- [x] 使用真实 daemon 发送带观察指令的提示。让脚本化模型调用 `SessionObserve`，验证工具返回目标 Run 状态。另一条普通提示确认看不到该工具。
- [x] 运行 server 相关测试、受影响包类型检查、`pnpm check:retired-ui`、`pnpm check-docs` 和 `git diff --check`。
- [x] 交给独立子代理审查最终实现，并修复确认的问题后复查。

## 验收记录

- 三组跨会话测试共 37 项通过。真实 HTTP 和 daemon 用例使用脚本化模型验证本轮工具注入、固定目标和输出范围。
- Server 全量测试通过 2225 项，跳过 1 项。最后调整所有权接线和测试目录后，定向回归 131 项通过。
- 相关存储测试 14 项、输入与文件领域校验 7 项通过。Server 类型检查、Server 与 Client 联合类型检查、架构检查、文档和旧引用检查通过。
- 独立代码复审发现并复核了目标运行 ID 重建的修复。

## 推送前复查

- 同一输入 ID 的重试需要保留原授权意图。旧输入可沿普通入口恢复。
- 观察工具遵循全局、会话和角色的工具规则，并在调用和返回前复核当前规则。同名自定义工具仅在本次观察运行中让位。
- Server 全量测试通过 2232 项，跳过 1 项。实时模式检查完成后，Server 定向回归通过 133 项。运行时定向回归通过 55 项。
