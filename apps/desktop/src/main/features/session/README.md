# 桌面会话入口

本目录承接桌面主进程的会话、项目和后台连接请求，将结果返回给 IPC（主进程与界面之间的消息通道）。

## 主要文件与调用流程

- `ipc.ts` 注册界面可调用的入口，沿用共享请求和返回类型。
- `session-service.ts` 的 `DesktopSessionService` 获取本次调用使用的 client（向后台发请求的连接对象），然后把它和输入交给具体操作。构造时可以传入连接依赖；不传时仍创建带浏览器宿主的 `DaemonConnectionService`。
- `daemon-connection-service.ts` 查找或启动后台，保存当前连接的 Promise，并负责刷新、重启、切换数据目录和关闭。连接失效时通知订阅方；连接失败后允许重试。
- `session-operations.ts` 执行会话和项目操作。分支切换、创建分支与其他方法一样显式接收 client；Git 等待结束后仍用本次调用持有的 client 检查项目并返回详情，交错调用不会覆盖彼此的连接。
- `project-operations-support.ts` 执行 Git 命令、读取分支并补充项目目录是否可用。
- `session-subscription-service.ts` 保存窗口对应的会话订阅和推送状态。服务入口接到连接失效通知后清除订阅；活动订阅的连接替换由 `activitySubscriptions` 处理。
- `session-operation-input.ts` 校验操作输入；`runtime-selection.ts` 解析桌面默认模型选择。其余读取和转换辅助文件放在本目录对应功能旁。

## 新增代码和测试

新增会话或项目动作放在 `session-operations.ts` 或其对应职责的辅助文件，服务入口负责获取 client 和转交输入。连接缓存、重建与关闭逻辑保留在连接服务中，不在操作类保存临时 client。

新测试放在 `__test__/`；已有测试可就地补充。`__test__/session-branch-client.test.ts` 暂停 Git 步骤，验证交错的分支调用和迟到连接各自返回所属 client 的项目详情。现有 `session-operations-worktree.test.ts`、`session-service*.test.ts` 和 `daemon-connection-service.lifecycle.test.ts` 覆盖工作目录补偿、输入转交、切换失败恢复和安全关闭。
