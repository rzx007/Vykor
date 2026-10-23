# 执行环境与沙箱源码

[index.ts](index.ts) 是 `@vykor/sandbox` 的公开入口，导出环境工厂、设置解析、权限策略、可用性探测及进程创建/停止函数。

## 目录导航

- [configuration/](configuration/README.md)：解析设置与执行环境选择。
- [policy/](policy/README.md)：生成调用策略、检查文件路径和处理审批模式。
- [environment/](environment/README.md)：本机/WSL 工厂、路径与平台事实。
- [process/](process/README.md)：启动和停止进程、SRT 参数及临时文件。
- [__test__/](__test__/)：跨分类公开接口测试。

宿主先解析设置，再传入工作区绑定、sessionId、技能目录及已解析的环境变量创建执行环境。工厂返回 `ExecutionEnvironmentHandle`；调用方经 process 执行命令或经 terminal 准备终端目标，结果通过输出监听和 wait 返回。文件接口需由宿主补充实际实现。

配置和工作区绑定保存在返回的句柄中，策略按调用计算，子进程状态归 process 模块。新增具体逻辑进入相应分类，公开能力从本层导出；测试随被测分类，真实系统端到端测试放包根 [../__test__/e2e/](../__test__/e2e/)。
