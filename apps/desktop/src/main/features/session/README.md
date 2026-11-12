# 桌面会话入口

本目录承接桌面主进程的会话、项目和后台连接请求，将结果返回给 IPC（主进程与界面之间的消息通道）。

## 主要文件与调用流程

- `ipc.ts` 注册界面可调用的入口，沿用共享请求和返回类型。
- `session-service.ts` 的 `DesktopSessionService` 获取本次调用使用的 client（向后台发请求的连接对象），然后把它和输入交给具体操作。构造时可以传入连接依赖；不传时创建 `DaemonConnectionService`，连接后从主进程接上浏览器桥。
- `daemon-connection-service.ts` 复用 SDK 查找或启动独立后台，保存当前 client，并在后台重启、数据目录切换时重连。连接失效时通知订阅方；连接失败后允许重试。
- `session-operations.ts` 执行会话和项目操作。分支切换、创建分支与其他方法一样显式接收 client；Git 等待结束后仍用本次调用持有的 client 检查项目并返回详情，交错调用不会覆盖彼此的连接。
- `project-operations-support.ts` 执行 Git 命令、读取分支并补充项目目录是否可用。
- `session-subscription-service.ts` 保存窗口对应的会话订阅和推送状态。服务入口接到连接失效通知后清除订阅；活动订阅的连接替换由 `activitySubscriptions` 处理。
- `session-operation-input.ts` 校验操作输入；`runtime-selection.ts` 解析桌面默认模型选择。其余读取和转换辅助文件放在本目录对应功能旁。

## 新增代码和测试

新增会话或项目动作放在 `session-operations.ts` 或其对应职责的辅助文件，服务入口负责获取 client 和转交输入。连接缓存、重建与关闭逻辑保留在连接服务中，不在操作类保存临时 client。

新测试放在 `__test__/`；已有测试可就地补充。`__test__/session-branch-client.test.ts` 暂停 Git 步骤，验证交错的分支调用和迟到连接各自返回所属 client 的项目详情。现有 `session-operations-worktree.test.ts`、`session-service*.test.ts` 和 `daemon-connection-service.lifecycle.test.ts` 覆盖工作目录补偿、输入转交、切换失败恢复和安全关闭。

`session-service.ts` 的 `checkPromptAccepted` 只读取 daemon 的会话输入记录，返回指定输入 ID 是否已被接收；不打开订阅、不创建或重跑任务。renderer 在失败重试前调用对应 IPC，读取失败不能被解释为“未接收”。

`bootstrap()` 把进程已固定的用户根交给工作区文件访问列表；工作区服务没有显式 `allowedRoots` 时也使用同一个根，避免启动后的环境变量变化把受保护配置当成普通外部文件。这里不改变项目外工作区或 worktree 的实际目录分配。
