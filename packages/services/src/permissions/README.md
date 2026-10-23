# 权限记录

保存权限请求、处理结果和决策作用范围。

## 入口与流程

PermissionRepository 创建、查询和回复权限请求，通过原子写入更新会话状态及相关记录；commands 定义应用传入的操作参数。

## 状态归属

请求和决定保存在共享会话状态与 SQLite，等待回复及宿主授权由调用方的权限服务管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [commands.ts](./commands.ts) | `CreatePermissionRequestInput`、`ReplyPermissionInput`、`ListPermissionRequestsOptions` |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [permission-records.ts](./permission-records.ts) | `PermissionRepositoryOptions` |
| [permission-repository.ts](./permission-repository.ts) | `PermissionRepository` |

## 测试与维护

权限记录读写及回滚规则放在这里，弹窗、等待和工具授权协调放在应用或执行宿主中。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
