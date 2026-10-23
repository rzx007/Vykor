# 仓库脚本

这里放跨包的开发、检查和发行入口，模块内部脚本随对应包维护。根 `package.json` 提供常用命令；脚本不保存用户会话数据。

- 官方插件的构建和单测由 `vykor-plugins` 仓库负责。宿主不再包含或准备这些插件的源码；需要跨仓库兼容性检查时，显式设置测试环境变量 `VYKOR_OFFICIAL_PLUGINS_DIR` 指向该仓库的 `plugins` 目录。
- `prepare-office-engine.mjs`：按宿主 Office 模块的固定摘要准备引擎并复制该模块的许可证；下载和缓存均独立于插件，不分发或安装插件。插件发行准备由独立的插件市场仓库负责。
- `check-docs.mjs`：文档链接与当前源码入口检查。
- `sync-plugin-app-client.mjs`：从 `packages/plugins/src/app-client/client.ts` 生成独立插件使用的浏览器模块和类型声明；`--check` 核对示例、参考资产和天气模板中的副本，不改文件。
- `pnpm check:retired-ui`：旧 UI 引用及实现退役检查，历史引用需在精确到行的登记表中注明原因。

新增脚本按用途命名；只为某个插件服务的脚本放到该插件目录，新增测试放所属 `__test__/`。发行临时产物写入忽略目录，不与源码或运行数据混放。
