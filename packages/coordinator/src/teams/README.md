# 团队注册表

[`index.ts`](index.ts) 提供 `TeamRegistry`、`createTeamRegistry()` 和限制可见操作的 `narrowTeamPort()`。可从 `@vykor/coordinator/teams` 或 `@vykor/coordinator` 导入。

宿主创建注册表后，调用 `createTeam()` 创建团队，再通过 `addAgent()` 登记任务标识、`sendMessage()` 追加团队消息，`listTeams()` 按名称返回团队。重复创建团队或操作不存在的团队会报错。

团队名称、说明、成员和消息保存在 `TeamRegistry` 实例的内存表中；本目录不执行任务、不传送跨进程消息，也不落盘。`narrowTeamPort()` 绑定原实例方法，供工具只持有所需操作。

团队数据操作继续放在本目录，新增测试放同层 `__test__/`；包入口及跨分类测试放在 `src/__test__/`。返回[源码导航](../README.md)。
