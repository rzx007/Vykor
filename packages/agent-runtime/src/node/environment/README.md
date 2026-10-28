# 本机执行环境

`default-node-terminal.ts` 创建或选择默认终端，标记能力是否可用以及由谁负责释放。`default-runtime-sandbox.ts` 检查执行环境的隔离能力，并将状态写入运行资源对象，供调用方展示和判断。

agent 组装时请求默认终端，运行资源接入时更新环境状态。终端句柄与释放回调交给资源拥有者管理，隔离状态保存在 `NodeRuntimeResources.sandboxStatus`。

新增终端和环境接入放在本目录。实际命令执行由终端、执行与环境相关包提供，子 agent 的工作目录申请放在 `../children/`。测试放在同层 `__test__/`。


## 共用执行核心（阶段 A）

默认 Terminal 工厂从 TerminalProvider 创建共同 bundle；自定义 provider 同样使用此 bundle，并由组装清理订阅。
