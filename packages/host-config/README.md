# @vykor/host-config

本机配置的唯一入口：Settings 和 Hook/Permission/MCP 配置类型、目录规则、读取校验、文件锁、冲突检测与原子保存。

配置文件和凭据格式保持原样。通用执行数据引用 agent-contracts，跨进程审批模式引用 protocol；MCP 活体连接和协调器由 mcp 包提供。

```powershell
pnpm --filter @vykor/host-config test
```
