# 工作目录管理

从 `@vykor/daemon-admin/workspace` 使用 `CommandCatalogResource` 查命令目录，使用 `ProjectResource.init` 写入项目初始规则，使用 `DevelopmentResource` 查 Hook 或调用 Git。调用方传入 daemon 所在机器的工作目录，daemon 执行操作并返回结果。

新命令目录、规则初始化与 Git 调用放在相应资源。Desktop 项目登记继续由 Desktop 的项目服务调用。
