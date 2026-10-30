# 页面内容集合

[docs/](./docs/README.md) 保存手写 Markdown/MDX、分类说明和 TypeDoc 自动生成的参考。上层 [content.config.ts](../content.config.ts) 使用 Astro 文件加载器，并排除 README。

调用入口是 Astro 内容构建。frontmatter 定义标题和描述，Starlight 生成导航与目录；文档内容没有运行时服务状态。新页面放到相应指南分类，自动 API 只由 TypeDoc 更新。
