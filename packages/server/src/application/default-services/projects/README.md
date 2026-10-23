# 项目默认服务

实现 Git 操作和项目初始化的默认应用接口。

## 入口与流程

Git 服务接收仓库操作，项目初始化服务准备项目配置与环境，结果交给上层应用或 HTTP 路由返回。

## 状态归属

仓库内容由文件系统与 Git 保存，项目记录由上层项目服务管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [git-service.ts](./git-service.ts) | `createDefaultGitService` |
| [project-init-service.ts](./project-init-service.ts) | `createDefaultProjectInitService` |

## 测试与维护

仓库操作和初始化的默认适配放在这里；项目归档、重绑定和桌面工作树操作放在 application/projects。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
