# 权限请求与配置管理

处理权限请求等待、回复、作用范围，以及权限和隔离配置检查。

## 入口与流程

权限控制器和存储代理创建请求、等待决定，再把回复交给运行；配置管理函数校验权限与隔离设置，返回可展示结果。

## 状态归属

请求和决定通过权限存储保存，等待者与取消监听保存在控制器中，配置由配置服务管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [approval-review-service.ts](./approval-review-service.ts) | `ApprovalReviewServiceInput`、`PermissionApprovalReviewServiceOptions`、`createPermissionApprovalReviewService` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [permission-broker.ts](./permission-broker.ts) | `PermissionReplyStatus`、`PermissionDecisionScope`、`PermissionAskInput`、`PermissionApprovalReviewHook` 等 |
| [permission-controller.ts](./permission-controller.ts) | `PermissionControllerWaitInput`、`PermissionController` |
| [session-approval.ts](./session-approval.ts) | `sessionPermissionRequest` |
| [settings-management.ts](./settings-management.ts) | `inspectPermissionConfiguration`、`checkPermissionConfiguration`、`validatePermissionConfiguration`、`validateIsolationConfiguration` |

## 测试与维护

权限请求协调与应用侧配置检查放在这里；工具自身的访问校验留在工具目录。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
