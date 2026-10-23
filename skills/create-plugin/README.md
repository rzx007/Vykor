# create-plugin

可独立分发的 Native Plugin 开发 Skill。分发整个目录，保留 `SKILL.md`、`references/`、`scripts/`、`templates/` 和 `assets/`；按个人或项目 Skill 的原安装方式使用，不要求接收者拥有 Vykor 源码。

默认工程是 [天气与出行助手](templates/weather-travel/README.md)，通过 `scripts/create-plugin.mjs` 生成新的独立项目，可选 Native Tools 或 MCP 后台，保留相同的业务、页面和插件内天气 Skill。使用 Node.js 24，进入新目录执行 `npm ci`、`npm run build`、`npm test`、`npm run validate` 和 `npm run pack`，得到可导入的 ZIP。创建命令和后台选择见 [SKILL.md](SKILL.md)。

`assets/text-inspector/` 是仅处理传入文本的进阶参考，不是默认脚手架。默认工程锁定官方 MCP Apps 1.1.2；MCP 后台使用官方 SDK 1.29.0。构建会把页面及所需依赖打包到产物，最终用户安装时不构建、不下载依赖。

根清单和 `apps.json` 使用 `schemaVersion: 1`，页面入口是 `components.apps`。Native 工具通过 `metadata.appData` 提供页面数据，MCP 使用 `structuredContent`；页面调用官方 `callServerTool`、`updateModelContext` 和 `sendMessage`。持久数据由宿主绑定的数据目录保存，升级按原重新导入流程完成，不修改安装快照或用户数据。
