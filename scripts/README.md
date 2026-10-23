# 仓库脚本

这里放跨包的开发、检查和发行入口，模块内部脚本随对应包维护。根 `package.json` 提供常用命令；脚本不保存用户会话数据。

- `test-marketplace-plugins.mjs`：`pnpm test:plugins` 的入口，准备 Office 共享引擎模块并检查研究与写作、办公文档的 Native Tool。Excalidraw 使用独立 npm 依赖和 Vitest，需在 `plugins/excalidraw` 执行构建、单元测试及 `test:stdio`。
- `prepare-office-engine.mjs`：为宿主文档功能准备固定摘要的引擎，不分发或安装插件。插件发行准备由 `plugins/office-work/scripts/build.mjs` 负责。
- `check-docs.mjs`：文档链接与当前源码入口检查。
- `sync-plugin-app-client.mjs`：从 `packages/plugins/src/app-client/client.ts` 生成独立插件使用的浏览器模块和类型声明；`--check` 核对示例、参考资产和天气模板中的副本，不改文件。
- `pnpm check:retired-ui`：旧 UI 引用及实现退役检查，历史引用需在精确到行的登记表中注明原因。

新增脚本按用途命名；只为某个插件服务的脚本放到该插件目录，新增测试放所属 `__test__/`。发行临时产物写入忽略目录，不与源码或运行数据混放。
