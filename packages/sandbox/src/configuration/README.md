# 执行设置解析

把可选沙箱设置补成完整值，并把 Native/WSL 产品配置转换成可执行的环境选择。

## 主要文件

- [config.ts](config.ts)：整理沙箱默认值、文件访问和网络规则。
- [execution-config.ts](execution-config.ts)：解析 local/wsl 选择并拒绝不支持的组合。

## 调用与状态

从包根调用 `normalizeSandboxConfig` 和 `resolveExecutionEnvironmentConfig`；无法支持的设置抛出 `ExecutionConfigError`。

先检查 `agentEnvironment.kind` 是否为 native 或 wsl，再整理沙箱设置。native 或未配置时返回 local；wsl 返回要求预检成功的配置，若同时启用 SRT 则立即报错。解析结果供 environment 工厂使用。

这里只返回新配置对象，不写 settings 文件、不创建环境句柄；原始设置文件和保存操作归 `@vykor/host-config` 及宿主。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
