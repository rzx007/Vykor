# 跨包生命周期测试夹具

`task-lifecycle-fixture.ts` 通过真实 Node 工厂与 DaemonApplication/session executor 驱动 Agent、Jobs、Shell、PTY 与 Workflow。受控边界仅为模型网络、环境/清理门闩与指定 store 故障；decorator 完整调用 base.execute，Read 在真实读取后等待释放，整个真实 invocation 保持未结束。普通权限和当前宿主派发检查仍覆盖这些包装后的真实调用。

入口是相邻的 child-run-settlement、shared-job-composition 和 workflow-child-lifecycle 测试。运行状态由真实 Kernel、ChildManager 与临时 SessionStore 保存；夹具只提供受控模型响应和测试暂停点。新增生命周期断言放在父测试，测试暂停点留在夹具内。

单次工具操作以实际 `tool.completed` 为返回边界。主运行仍在等待子任务时，后续测试命令通过 steer 追加到原运行，使 Read、Wait、Send 和 Cancel 保持可测；不再先等待父运行的最终答复。离线模型区分真实测试命令与内部子结果报告，避免报告重复启动同一脚本。修改模型目录等测试条件前，可用 `waitForRoot()` 等待主运行收尾。
