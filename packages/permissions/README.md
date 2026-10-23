# @vykor/permissions

判断一次工具调用应允许、拒绝还是询问用户，结合权限模式、工具名单、路径规则和命令规则。

## 功能

- `PermissionChecker` 统一检查工具调用，显式拒绝规则优先。
- `effectivePermissionMode()` 将审批方式和工作方式转换为底层检查模式。
- 支持 Windows 与 POSIX 路径匹配，以及只读工具范围检查。

## 目录与入口

公开入口是 [`src/index.ts`](src/index.ts)，通过 `@vykor/permissions` 导入。实现说明见 [src 源码导航](src/README.md)，模式映射在 [`src/effective-permission-mode.ts`](src/effective-permission-mode.ts)，测试在 [`src/__test__`](src/__test__)。

宿主把当前配置交给检查器，调用 `checkTool()` 得到 `PermissionDecision`，再决定是否执行或展示确认。当前模式与规则保存在检查器实例内存中，配置保存、用户确认和工具执行由宿主负责。新增检查逻辑保持在 `src/`，测试放同层 `__test__/`。

## 使用

```ts
import { PermissionChecker } from "@vykor/permissions";

const checker = new PermissionChecker({ mode: "default", cwd: process.cwd() });
const decision = await checker.checkTool("Read", { path: "README.md" });
```

## 测试

```bash
pnpm --filter @vykor/permissions test
```
