# @vykor/sandbox

这个包目前承担两项职责：

- Native/WSL 的执行环境工厂、路径转换和 WSL 预检；
- Native 环境中的可选 SRT 权限边界。

Docker Agent Runtime 已删除。本包不再创建容器、挂载目录、维护 lease 或提供容器 PTY。

## 运行环境

`agentEnvironment.kind` 的产品值是 `native | wsl`，内部映射为 `local | wsl`。Windows 盘符路径集中转换为 `/mnt/<drive>/...`；WSL Linux 文件系统 UNC 项目暂不支持。

WSL 进程通过 `wsl.exe --cd <cwd> --exec <argv>` 启动。用户终端和 Agent Terminal 通过 node-pty 启动同一环境目标。

## SRT

`SandboxPolicy` 根据 cwd、settings 和可选 sessionId 生成调用级策略。`createShellProcess` / `createProcess` 在 Native 环境中按策略使用 SRT；`failIfUnavailable=true` 时依赖缺失会明确失败。

WSL 与 SRT 的组合目前不支持并 fail-closed。WSL 不是安全沙箱。

## CLI

```bash
vk sandbox enable
vk sandbox enable --global
vk sandbox enable --fail-open
vk sandbox disable
vk sandbox status
vk sandbox check
```

## 验证

```bash
pnpm --filter @vykor/sandbox test
pnpm --filter @vykor/sandbox e2e:wsl
pnpm --filter @vykor/sandbox e2e:srt
```

SRT 或其平台依赖不可用时，SRT E2E 会明确跳过；WSL E2E 只在 Windows 且默认发行版可用时运行。
