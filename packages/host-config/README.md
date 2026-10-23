# @vykor/host-config

本机配置的唯一入口：Settings 和 Hook/Permission/MCP 配置类型、目录规则、读取校验、文件锁、冲突检测与原子保存。

配置文件和凭据格式保持原样。通用执行数据引用 agent-contracts，跨进程审批模式引用 protocol；MCP 活体连接和协调器由 mcp 包提供。

```powershell
pnpm --filter @vykor/host-config test
```

## 目录与维护

| 目录 | 用途 |
| --- | --- |
| [src/](./src/README.md) | 提供用户与项目配置的类型、读取、校验和保存入口。 |
| [src/extensions/](./src/extensions/README.md) | 定义 Hook、MCP 连接配置和凭据记录格式。 |
| [src/permissions/](./src/permissions/README.md) | 定义审批模式并整理权限设置。 |
| [src/settings/](./src/settings/README.md) | 管理设置类型、合并规则、受控修改以及工具和调度配置。 |
| [src/storage/](./src/storage/README.md) | 确定配置与 Git 路径，并提供配置文件的原子写入。 |

入口与流程：先确定配置目录，读取并合并用户与项目设置，再校验字段；修改时通过现有锁和原子写入流程保存。

状态归属：配置文件保存在用户或项目配置目录；读取结果和单次修改上下文由调用方持有。

新增实现优先放入职责对应的分类；测试放在被测目录的 `__test__/`。迁移时同步公开导出目标、调用方导入、文档和旧引用清单。

```powershell
pnpm --filter @vykor/host-config test
pnpm --filter @vykor/host-config check-types
```
