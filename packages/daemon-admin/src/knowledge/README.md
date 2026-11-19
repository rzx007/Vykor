# 项目知识管理

从 `@vykor/daemon-admin/knowledge` 使用 `KnowledgeResource`。它通过 daemon 的工作目录或会话参数读取项目记忆、事实与上下文，也可更新、替换或清理。daemon 校验修订版本和会话范围，并保存修改。Dream 请求返回后台任务 ID，后续执行状态用公开 Jobs 读取。

新增知识读取、编辑或 Dream 调用放在 `knowledge-resource.ts`，已有协议类型从子入口再导出。
