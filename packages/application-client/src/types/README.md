# 产品业务类型

[index.ts](./index.ts) 定义命令、项目、提供商、配置及应用输入；[extension-types.ts](./extension-types.ts) 定义插件展示与市场类型；[attachment-types.ts](./attachment-types.ts) 定义附件存储维护结果。

业务资源和命令从本目录引用参数及响应定义。会话、消息、事件、状态、模型和技能目录类型从公开 SDK 导入或重导出，保持同一个定义来源；协议业务记录直接重导出自 Protocol。类型本身不保存运行状态。新业务定义放对应文件，核心生命周期类型放 SDK。
