# 站点配置

本目录配置文档站的网址，以及从已发布 SDK 声明生成的 API 参考；不扫描服务端或桌面业务源码。

- `api-options.mjs`：共享两份声明入口、TypeDoc 选项和输出目录；原生 Node 测试直接读取这些选项。
- `api-reference.ts`：将共享选项交给 `starlight-typedoc`，由 `astro.config.ts` 的 Starlight `plugins` 加载。
- `site.mjs`：处理站点网址和部署子路径，供 Astro 配置与链接检查使用。
- [`../tsconfig.api.json`](../tsconfig.api.json)：仅为 `packages/client/dist/index.d.ts` 和 `service.d.ts` 创建类型检查上下文，不继承仓库源码别名。

生成文档前需要构建 `@rzx/client`；仓库根 `docs:build` 按工作区依赖顺序完成构建。插件随后读取两个实际发布入口，生成 `src/content/docs/api/` 下的 Markdown，并把 API 参考加入侧栏。生成索引使用 `index.md`，对应 `/api/`、`/api/index/` 和 `/api/service/`，与仓库内部的 README 页面区分。生成内容由插件管理，不手工编辑或提交。

API 范围与 `packages/client/package.json` 的 `exports` 一致：浏览器入口 `@rzx/client` 和 Node 入口 `@rzx/client/service`。私有、受保护和标注为内部的成员不会进入参考页；关闭源码位置和 Git 链接，避免在页面中公开仓库路径。包 README 不作为 API 页面读取。

新增公开入口时，应先确认 SDK 的发布出口，再同步本目录、专用 tsconfig 和 [API 范围回归](../scripts/__test__/api-reference.test.mjs)。测试实际运行 TypeDoc，检查两个模块、核心符号、业务类型边界与源码元数据，不依靠配置文本匹配。
