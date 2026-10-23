# Node 终端源码

[index.ts](index.ts) 是 `@vykor/terminal-node` 的公开入口，导出 `LocalTerminalProvider`、`createAgentTerminalBundle`、输出容器及 Shell/目标辅助函数。

## 目录导航

- [host/](host/README.md)：Agent 会话与 Jobs 能力适配。
- [providers/](providers/README.md)：PTY 创建、环境目标、信号和关闭。
- [output/](output/README.md)：合并输出与按游标读取的内存记录。

宿主创建 provider 并解析终端 cwd；provider 准备本机或执行环境目标后启动 node-pty。输出先合并，再加入内存记录并发出事件；host 把同一 provider 暴露给 Agent Terminal 和 Jobs，结果经这些接口返回。

真实进程和会话状态归 provider，输出状态归每个终端自己的 output 实例，host 只保存观察时间和归属约束。新增实现进入相应分类，公开能力补本层导出；测试放各分类同层 `__test__/`，未来跨分类测试放本层 `__test__/`，目前本层没有该目录。
