# 项目与工作目录

管理项目列表、属性、工作目录重绑定和桌面 Git 工作树创建。

## 入口与流程

`ProjectApplicationService` 验证目录，检查会话与终端是否空闲后执行重绑定；桌面工作树函数通过现有工作树能力创建并返回目录。

## 状态归属

项目记录由项目接口保存，仓库和工作树位于文件系统，活跃会话与终端由运行服务持有。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [desktop-git-workspaces.ts](./desktop-git-workspaces.ts) | `createDesktopGitWorktree` |
| [project-application-service.ts](./project-application-service.ts) | `ProjectOperations`、`ProjectApplicationService` |

## 测试与维护

项目范围的检查与协调放在这里；Git 命令默认实现放在 default-services/projects。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
