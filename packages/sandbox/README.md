# @vykor/sandbox

提供 Native（本机）/WSL（Windows 中的 Linux 环境）执行环境工厂、路径转换和 WSL 预检，并在 Native 进程执行时按配置使用 SRT（为命令限制文件和网络访问的外部运行器）。

## 目录导航

- [src/](src/README.md)：公开入口及从配置到环境的运行过程。
- [src/configuration/](src/configuration/README.md)：执行环境与沙箱设置整理。
- [src/policy/](src/policy/README.md)：调用权限、路径校验和审批模式转换。
- [src/environment/](src/environment/README.md)：本机/WSL 环境、平台检测与运行器可用性。
- [src/process/](src/process/README.md)：命令创建、SRT 包装和进程树停止。
- [__test__/e2e/](__test__/e2e/)：需要实际系统依赖的端到端用例。

## 入口、流程与边界

包入口为 [src/index.ts](src/index.ts)。`resolveExecutionEnvironmentConfig` 把产品设置中的 `agentEnvironment.kind: native | wsl` 映射成内部 `local | wsl`；`createExecutionEnvironment` 预检环境，返回进程、终端目标、路径解析和环境信息。工厂当前返回的 files 接口未配置，真实文件操作需要宿主另外接入。

`resolveSandboxPolicy` 根据 cwd、settings 和可选 sessionId 返回调用策略；`createShellProcess` / `createProcess` 在本机环境中按策略启动命令，启用 SRT 时写入临时设置并包装命令。缺少运行器且 `failIfUnavailable=true` 时明确失败，允许降级时使用本机执行。

Windows 盘符路径集中转换为 `/mnt/<drive>/...`；WSL Linux 文件系统 UNC 项目暂不支持。WSL 进程通过 `wsl.exe --cd <cwd> --exec <argv>` 启动，交互终端由 terminal-node 使用 node-pty 启动相同环境目标。WSL 与 SRT 的组合目前直接拒绝；WSL 本身不提供这里的安全沙箱边界。

Docker Agent Runtime 已删除，本包不创建容器、挂载目录或提供容器终端。环境句柄保留本次配置和路径绑定；策略按调用生成，子进程和临时 SRT 配置由 process 分类管理。密钥环境变量由宿主解析后传入，不放进对模型展示的环境信息。

## CLI 与检查

```bash
vk sandbox enable
vk sandbox enable --global
vk sandbox enable --fail-open
vk sandbox disable
vk sandbox status
vk sandbox check
pnpm --filter @vykor/sandbox test
pnpm --filter @vykor/sandbox e2e:srt
```

单元测试放被测分类的 `__test__/`，跨分类测试放 `src/__test__/`；端到端用例统一放包根 `__test__/e2e/`。SRT 用例在运行器或平台依赖不可用时明确跳过。新增端到端用例时同步包脚本与测试配置。
