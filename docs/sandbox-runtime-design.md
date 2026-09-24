# Native / WSL 运行环境与 SRT

> 状态：当前实现，最后核对：2026-09-08。

Vykor 把“在哪里运行”和“允许做什么”分成两层：

- `agentEnvironment` 选择 Native 或 WSL；
- `sandbox` 是可选的本机 SRT 权限边界。

Docker Agent Runtime 已移除。WSL 是 Linux 运行环境，不等于安全沙箱。

## 配置

```json
{
  "agentEnvironment": { "kind": "native" },
  "sandbox": {
    "enabled": false,
    "failIfUnavailable": false,
    "filesystem": {
      "allowRead": ["."],
      "allowWrite": ["."]
    },
    "srt": { "runtimeCommand": "srt" }
  }
}
```

`agentEnvironment.kind` 只接受 `native | wsl`。WSL 只在 Windows 展示，使用系统默认发行版；保存前预检，失败时不回退 Native。设置修改后重启 daemon 生效。

SRT 保留既有 `enabled`、`failIfUnavailable`、filesystem/network 和 `runtimeCommand` 配置，不再有 backend、Docker 镜像、挂载或容器复用配置。WSL 与 SRT 同时启用目前明确失败；让 SRT 在 WSL 内运行是独立后续工作。

## 平台

| 宿主 | Agent 环境 | SRT |
| --- | --- | --- |
| Windows | Native、WSL | Native Windows 不支持；WSL 组合暂未接入 |
| macOS | Native | 需要 `sandbox-exec` |
| Linux | Native | 需要 `bwrap` |

WSL 首期支持 Windows 盘符项目，例如 `D:\code\vk ↔ /mnt/d/code/vk`。`\\wsl.localhost\...` 与 `\\wsl$\...` 项目根暂不支持，避免宿主 Git/worktree 与 Linux 文件系统的所有权不一致。

## 安全边界

Permission/approval 先决定工具调用是否允许，SRT 再限制 Native 进程。WSL 负责执行位置；它默认可能访问 `/mnt/c` 等 Windows 驱动器，因此不能被描述为强隔离。

附件继续使用 `attachment://<assetId>`，由宿主控制面授权和读取。Skill 由宿主发现，交给 WSL Agent 的 file/root 路径通过统一 resolver 转为 POSIX 路径。

真实 WSL 验收覆盖 cwd、环境变量、退出码、文件读写、glob/grep、后台 Shell、stdio MCP、PTY resize 和 Ctrl-C：

```powershell
pnpm --filter @vykor/sandbox e2e:wsl
```

SRT 验收：

```powershell
pnpm --filter @vykor/sandbox e2e:srt
```
