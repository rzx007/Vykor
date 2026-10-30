# SDK 文档内容

此目录保存面向公开 `@rzx/client` 消费者的中文指南。站点从首页进入，按快速开始、概念、操作指南和 API 参考阅读。默认场景是连接已有 daemon；Node 本机进程管理单列为可选内容。

| 目录或文件 | 用途 |
| --- | --- |
| [index.mdx](./index.mdx) | 站点首页和阅读导航 |
| [getting-started/](./getting-started/README.md) | 安装、连接与首个完整任务 |
| [concepts/](./concepts/README.md) | 公开生命周期和状态归属 |
| [guides/](./guides/README.md) | 按资源和任务组织的操作说明 |
| [reference/](./reference/README.md) | 公开入口与自动生成参考说明 |

daemon 保存会话和执行真相，SDK 合并快照与事件，应用保存交互状态。新增页面时核对公开入口及资源实现，不把应用私有业务或全量 HTTP 接口放进站点。示例源文件在 `apps/client-docs/examples/`，MDX 用 `?raw` 和 Starlight `Code` 组件引用，避免复制整份代码。

每个页面使用 Starlight 的 `title`、`description` frontmatter。站内链接使用与部署 base 兼容的相对路由，站点保持尾斜杠。此目录中的 `README.md` 是维护说明，由内容 loader 排除，不生成公开页面。
