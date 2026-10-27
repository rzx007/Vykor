# Jobs 后台任务协议

> 状态：当前实现的权威契约，阶段 A；最后核对：2026-10-27。

当前协议版本为 6，Jobs feature 为 3。SDK 与 daemon 使用同一套 Node 来源接线；旧版请求明确拒绝。

## 调用入口

创建仍通过 Agent、BackgroundShellCreate、TerminalOpen、Workflow。创建回执携带 target，后续调用原样传回：

```ts
const target = { kind: "agent", jobId: childId, runId };
JobRead({ target, after: cursor });
JobWait({ targets: [{ target, after: cursor }], timeoutSeconds: 20 });
JobSend({ target, data: "继续" });
JobCancel({ target, reason: "完成验证" });
JobList({ includeFinished: true }); // { jobs, errors, window }
```

Agent target 必须含已接纳的 runId；其他 kind 为 shell、terminal、workflow、dream，只需 jobId。Workflow jobId 就是原始 Workflow runId。JobSnapshot.target 是完整可复用目标，id 与 target.jobId、kind 与 target.kind 必须一致。

Agent 工具回执同时包含 target、inputId、runId、childSessionId，jobId 沿用 childId。JobSend 对框架 child 返回 receipt：`{sessionId,inputId,runId}`；其他交互进程可能没有回执。旧轮 send 报冲突，旧轮 cancel 只作用于该轮，不关闭 child 身份或停止后来一轮。

## 执行与状态

`RoutedAgentJobHost` 在构造时按 kind 固定来源。定点 read、wait、send、cancel 不列举任何来源。list 分别查询每种来源，返回 `{jobs,errors}`，某个来源失败不遮蔽其他成功项。

child 的每轮结果存在 ChildManager 的 requests；readRun/waitRun 固定该轮，handle.result 只是最新一轮的便利入口，其 Promise 身份不能用于识别轮次。显式进程由 DetachedProcessSupervisor 持有；Terminal 由 LocalTerminalProvider 持有，定点查找用 get；Workflow live run 与调度保留在 WorkflowHost/coordinator。daemon 的持久记录是投影，不是第二个执行器。

wait 只等待目标执行器的完成或变化通知。观察超时返回 timedOut，不改变真实执行状态。cancel 接纳停止后可以返回 stopping；实际退出和输出收尾确认后才出现终态。Shell 环境尚未获得时取消，取得环境后只释放，不派发进程。进程结束后 send 不会用同一 ID 自动重启。

本阶段保留既有 child 身份额度与 5 分钟空闲回收规则。按 run 计额度及 Workflow runner 的进一步收拢属于后续阶段。

## HTTP 与 Client

GET /jobs 返回 `{jobs,errors}`。GET /jobs/:jobId 使用 sessionId、kind，Agent 另带 runId。wait/input/cancel 的 POST body 都传完整 target；URL jobId 必须与 body 一致。

```ts
const listed = await client.jobs.list({ sessionId });
const item = listed.jobs[0]!;
const read = await client.jobs.read(item.target, { sessionId });
const waited = await client.jobs.wait(item.target, { sessionId, timeoutMs: 1000 });
const receipt = await client.jobs.send(item.target, { sessionId, data: "继续" });
await client.jobs.cancel(item.target, { sessionId });
```

CLI 为 `/jobs show KIND ID [RUN_ID]` 与 `/jobs cancel KIND ID [RUN_ID]`；Agent 必须给 RUN_ID。列表和诊断显示来源 errors。桌面 Workflow 停止按钮传已选快照的 target。

## 归档与扩展

归档只在实时索引明确不存在时读取，不能因任意异常切换后端。历史列表按 kind、jobId、runId 合并，实时项优先。旧 Agent 行缺少 runId 时显示来源错误，不能伪造可取消目标。daemon 无 live root 时通过同一 Node bindings 读取已保存结果，不要求重新创建模型 Agent。

纯数据从 `@vykor/jobs/contracts` 导出；带信号的宿主请求留在 `@vykor/jobs`。Node 组装只接受 TerminalProvider、ShellAdmissionPorts、child environment 与持久只读端口，宿主不注入另一套 Jobs 生命周期。
