# 文档站内容与样式

入口是 [content.config.ts](./content.config.ts)：从 [content/docs/](./content/docs/README.md) 载入指南与生成的 API 页面，用 Starlight schema 校验 frontmatter。集合排除分类 README，避免维护说明成为公开页面。

内容和读取步骤见 [content/](./content/README.md)，主题覆盖见 [styles/](./styles/README.md)。页面由 Astro 在构建时生成，浏览器只加载静态页面、主题交互与搜索索引；本目录不保存会话状态。

新增页面归对应内容分类，展示的可运行示例放包根 examples；布局和导航放包根 astro 配置，不在页面复制维护。
