# 执行与文件权限策略

根据工作区、会话和设置生成本次调用可用的权限，并检查真实文件路径是否符合规则。

## 主要文件

- [policy.ts](policy.ts)：策略服务、拒绝错误与失败类别。
- [path-validator.ts](path-validator.ts)：解析符号链接和不存在路径的父目录，检查允许/拒绝范围。
- [approval-policy.ts](approval-policy.ts)：按会话审批模式调整沙箱设置副本。

## 调用与状态

包根公开 `resolveSandboxPolicy`、`DefaultSandboxPolicyService`、`validateSandboxPath`、`settingsForApprovalMode` 和失败分类函数。

先整理设置并记录 cwd、workspaceRoot、sessionId，再推导 off、read-only 或 workspace-write 模式及强制程度。路径校验先处理真实路径和符号链接，再检查拒绝项及允许根目录；结果带允许/拒绝和原因。full_access 使用设置副本，缩小权限时恢复基线设置。

策略对象属于调用方；审批基线以不可枚举 Symbol 保存在会话设置副本中，不写入配置文件。模块不持有进程或连接状态。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
