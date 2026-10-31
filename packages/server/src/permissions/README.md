# 权限请求与配置管理

处理权限请求等待、回复、作用范围，以及权限和隔离配置检查。

## 入口与流程

权限控制器和存储代理创建请求、等待决定，再把回复交给运行；配置管理函数校验权限与隔离设置，返回可展示结果。

普通工具请求可以复用“本会话允许”。工具内部针对具体来源、安装候选或其他确切操作的请求使用 `confirmation: "once"`：它不会复用已有的工具级会话授权，批准回复也只能保存为单次授权。此标记由 `sessionPermissionRequest` 转交，并与具体参数一同保存；自动审查和父子会话的存储路由仍按原规则处理。

自动审查从已保存的审批请求读取操作说明，例如浏览器站点、按钮名称和敏感操作提示，并通过 `evidence.context` 的 `reference` 类型提供给审查器。这些说明属于外部或工具参考信息，不能提供用户授权；`userInstruction` 仍由对应运行的原始用户输入或已核实的应用操作产生。

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
