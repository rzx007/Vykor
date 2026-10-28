# 跨包生命周期测试夹具

`task-lifecycle-fixture.ts` 通过真实 Node 工厂与 DaemonApplication/session executor 驱动 Agent、Jobs、Shell、PTY 与 Workflow。受控边界仅为模型网络、环境/清理门闩与指定 store 故障；decorator 完整调用 base.execute，Read 在真实读取后等待释放，整个真实 invocation 保持未结束。普通权限和当前宿主派发检查仍覆盖这些包装后的真实调用。

入口是相邻的 child-run-settlement、shared-job-composition 和 workflow-child-lifecycle 测试。运行状态由真实 Kernel、ChildManager 与临时 SessionStore 保存；夹具只提供受控模型响应和测试暂停点。新增生命周期断言放在父测试，测试暂停点留在夹具内。
