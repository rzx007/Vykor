# @vykor/terminal

定义各界面共用的终端会话、事件、提供方和连接接口，并提供轻量事件订阅器。包内不依赖 Electron、React、xterm 或 node-pty，也不直接创建 shell 进程。

## 目录导航

| 目录 | 用途 |
| --- | --- |
| [src](src/README.md) | 终端数据契约、提供方接口和事件订阅器 |

`@vykor/terminal` 对应 [src/index.ts](src/index.ts)，`@vykor/terminal/contracts` 对应 [src/contracts.ts](src/contracts.ts)，入口声明见 [package.json](package.json)。

终端会话有名称，进程退出后仍可按标识读取。会话使用 `@vykor/jobs` 的状态集合，包含可观察的 `stopping`。提供方实现 `read` 返回有大小限制的输出快照；快照和实时输出事件都带递增序号，界面据此连接两者，避免遗漏或重复。读取可携带旧序号，只取仍保留的新输出；`wait` 等待进程结束，不取消进程。

终端进程、会话列表和输出缓存由消费方实现的提供方管理，本包只在事件订阅器中保存监听函数。新增契约或共用订阅逻辑放 `src/`，测试建议放 `src/__test__/`。
