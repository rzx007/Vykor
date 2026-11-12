# 工作区文件与系统打开入口

本目录处理文件列表、预览、保存、复制路径和系统打开请求，不创建或搬迁用户项目。

## 入口与流程

`workspace-service.ts` 从 IPC 接收当前项目和目标路径，交给 `workspace-path.ts` 分类，再解析实际文件位置并检查是否仍在允许根内；通过后返回文件内容或预览字节。写入只允许当前项目。`opener-service.ts` 和同类辅助文件负责系统打开方式、图标与进程参数。

允许根由 bootstrap 的 `configureAllowedRoots({configDir,workspacesDir})` 注入；未注入时从进程已固定的数据根计算。额外访问范围包括个人 skills、USER.md、规范 workspaces/channels 以及明确注入的工作区根。读取、显示路径和系统打开会先用 `resolveManagedHistoryPath` 把受管历史路径解析到当前位置，然后继续原分类、realpath 和允许范围检查。旧来源和 excludedRoots 不加入文件允许根；原有显式外部文件打开规则仍适用。

## 状态与新增代码

允许根与正在保存的文件集合由 `WorkspaceService` 持有；文件内容保存在调用方指定的位置，服务不持久保存预览状态。同类文件访问逻辑放在这里，纯路径规则放在 `workspace-path.ts`。新增测试放在 `__test__/`；现有同目录测试可就地扩展。
