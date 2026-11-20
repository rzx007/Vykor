# 生命周期资源导航

[index.ts](./index.ts) 导出公开资源类；`VykorClient` 组合这些资源与 `ProtocolClient`，实例提供 protocol、runtime、sessions、permissions、attachments、jobs、events、files。

| 目录 | 资源与用途 |
| --- | --- |
| [configuration/](./configuration/README.md) | `PermissionResource` 查询和回复运行权限请求 |
| [files/](./files/README.md) | `FilesResource` 读取会话工作区目录、文件信息、文本并查找文件或内容 |
| [runtime/](./runtime/README.md) | `RuntimeResource` 读取已有能力，`JobResource` 观察和控制后台/子任务 |
| [session/](./session/README.md) | `SessionResource` 生命周期、`AttachmentResource` 附件、`EventResource` 事件 |

资源负责将动作映射到 HTTP 请求；协议握手与事件连接由 transport 完成。会话及运行事实保存在 daemon，同步视图交由 state 模块维护。

新增生命周期动作放对应分类，测试放被测分类的 `__test__/`。共享的后台管理请求按职责放在 `@vykor/daemon-admin`，Desktop 独有的功能放在各自的主进程模块。 [管理入口](../../../daemon-admin/README.md) · [产品接入](../../../../docs/product-surface-integration.md)
