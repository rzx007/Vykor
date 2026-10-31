# 工具结果跟踪

观察连续工具执行的结果，在重复失败时为模型补充行动提示，帮助它调整参数、检查前置条件或选择其他已授权方法。

`tracker.ts` 提供 `TrajectoryTracker` 接口、默认实现 `DefaultTrajectoryTracker`，以及创建和应用控制状态的函数。`QueryEngine` 通过 `applyTrajectoryTracker()` 提交一批工具调用与结果，再读取控制状态，用于后续模型请求。

连续失败次数保存在跟踪器实例中；提示文本、是否要求结束和隐藏工具列表保存在本次运行的 `TrajectoryLoopControl` 中。调用方可通过 `trajectoryTrackerFactory` 替换或关闭默认跟踪器。

规则交付进展由引擎在实际模型正文预算处理后统一判断，通过调用上的内部 `projectInstructionProgress` 标记传入。默认跟踪器把这种等待计作进展并清除连续失败提示；它不重新读取规则标记或原始正文，也不改变结果的 `isError` 和执行状态。自定义跟踪器仍能读取原始执行事实。无新交付、正文被裁剪及规则硬上限继续按失败观察。

只把基于执行结果的后续行动规则放在这里。参数检查与授权放在 `../tools/`，执行次数和生命周期限制由运行上下文负责。测试放在同层 `__test__/tracker.test.ts`。
