# @vykor/permissions

权限模式 + 拒绝规则系统。

## 功能

- PermissionMode: DEFAULT, PLAN, AUTO, DENY
- 拒绝规则引擎

## 使用

```ts
import { PermissionMode, checkPermission } from "@vykor/permissions";

const allowed = checkPermission("Read", "/path/to/file", PermissionMode.DEFAULT);
```

## 测试

```bash
pnpm --filter @vykor/permissions test
```