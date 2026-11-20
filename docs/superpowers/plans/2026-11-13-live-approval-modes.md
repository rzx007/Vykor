# 运行中授权模式切换实现计划

> 在当前会话逐项实现；沿用 Ponytail、测试驱动开发和完成前验证。

**目标：** 三种批准方式在运行中可切换，后续工具调用使用新模式，正在执行的调用和待批准请求保留原规则。

**实现方式：** 沿用会话更新接口；仅批准方式变化不更换运行实例版本。Node 在每次工具开始检查权限时捕获模式、设置和执行环境，通过标准库 AsyncLocalStorage 保留到调用结束；并行调用分别持有自己的值。Core 只提供执行边界回调，不依赖 Node。

**技术栈：** TypeScript、Node.js、现有 PermissionChecker、执行环境工厂、Vitest。

## 文件职责

- `packages/server/src/application/session/session-command-service.ts`：批准方式热更新准入、参数校验和实例版本。
- `packages/server/src/daemon/daemon-agent.ts`：按实际会话读取当前批准方式。
- `packages/server/src/permissions/session-approval.ts`：保留工具调用捕获的审核方式。
- `packages/core/src/engine/tools/checked-tool-execution.ts`、`packages/core/src/engine/query-engine.ts`、`packages/core/src/types/runtime.ts`：统一模型、显式和嵌套工具调用的执行边界。
- `packages/permissions/src/index.ts`：每次权限检查固定模式，保留现有规则与拒绝顺序。
- `packages/agent-runtime/src/node/runtime/tool-authorization.ts`：调用内的批准方式、设置和环境。
- `packages/agent-runtime/src/node/runtime/default-runtime.ts`：接入调用边界、权限检查、工具设置和命令 hooks。
- `packages/agent-runtime/src/node/agent/`：把捕获模式传给宿主批准请求与新建子任务。
- `packages/environment/src/types.ts`、`packages/sandbox/src/environment/execution-environment.ts`：从同一环境复制单次命令策略，完全访问退出时恢复基线。
- 各模块 `README.md`：说明入口、状态归属和生效边界；测试保留在对应 `__test__/`。

## 任务与验证

- [x] 会话服务：新增三种方式循环切换测试，先确认运行中返回 409；实现后确认保存成功且实例版本不变。混合更换 agent、计划模式与工具范围仍受原屏障保护。
- [x] 执行器：新增同一执行器的三种模式切换、并行旧调用、嵌套调用和串行排队测试。先确认后续调用仍沿用旧模式，再接入调用边界。
- [x] 执行环境：新增完全访问与恢复基线的命令策略测试；先确认旧环境无法切换，再复制进程策略，保留已经启动的进程。
- [x] 宿主批准：通过真实会话、Run 和批准代理验证旧人工请求、旧自动审核及新请求的区别；保留取消、归档、禁止规则和计划限制。
- [x] 运行针对性测试、受影响包类型检查、`pnpm check:retired-ui`、`pnpm check-docs`；检查差异，保留已有无关修改。

## 验收边界

仅修改批准方式时，界面等待后端成功后更新选中值；现有完全访问确认弹窗保留。已捕获的调用在等待审批和执行期间继续使用原设置；新调用读取最新方式。子会话不追溯修改，新建子任务按原继承和权限上限规则处理。进入或退出计划模式不属于本次热切换范围。

## 验证命令

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-command-service.test.ts src/permissions/__test__/session-approval.test.ts
pnpm --filter @vykor/permissions test
pnpm --filter @vykor/core exec vitest run src/engine/tools/__test__/checked-tool-execution.test.ts
pnpm --filter @vykor/sandbox exec vitest run src/environment/__test__/execution-environment.test.ts
pnpm exec vitest run --config tests/agent-integration/vitest.config.ts tests/agent-integration/__test__/live-approval-modes.integration.test.ts
pnpm --filter @vykor/core --filter @vykor/permissions --filter @vykor/environment --filter @vykor/sandbox --filter @vykor/agent-runtime --filter @vykor/server check-types
pnpm check:retired-ui
pnpm check-docs
```

## 实际验证结果

- 会话更新、权限检查、环境复制及并行调用的新增测试先失败，接入后通过；初次显式选择与网络规则另做了失败验证。
- 权限包 208 项、Core 包 616 项和沙箱包 49 项通过；3 项真实 WSL/SRT 用例按平台条件跳过。随后新增网络边界后，工具执行测试 34 项通过。
- Runtime/Agent 22 个测试文件、238 项通过；Native 插件宿主 16 项通过。
- Server 定向回归覆盖会话、批准、派发、后台进程、加载器和环境；后台服务修正后 8 项通过，其余 187 项已通过。
- 真实 daemon 热切换、完全访问及子环境跨包回归共 17 项通过，确认同一 Run 内未重建 Agent。
- 受影响包类型检查、Runtime 构建、旧界面引用检查和文档检查通过。
- 独立检查复核了后台命令、Native 插件、独立 hooks、CLI 沙箱基线和 MCP 新进程；修正后未发现剩余阻断问题。
- Windows SDK 测试的 node-pty 辅助进程仍输出 AttachConsole 错误日志，测试断言和退出码均通过；本次未修改该已有终端行为。
- 完全访问确认弹窗沿用原实现，未搭建 UI 预览或截图。没有提交或改写已有无关代码。