# 开发辅助与终端

[development-resource.ts](./development-resource.ts) 提供技能管理、Hook 和 Git 操作；[terminal-resource.ts](./terminal-resource.ts) 提供终端创建、读写、调整大小和事件订阅。

入口为客户端的 development 和 terminals。HTTP 请求和事件读取复用 SDK 连接；终端进程、Git 和技能状态由 daemon 管理。新增开发辅助和终端功能放本目录，测试放 `__test__/`；Agent Jobs 与只读运行能力目录仍在 SDK。
