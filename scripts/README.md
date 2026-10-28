# 仓库脚本

这里放跨包的开发、检查和发行入口，模块内部脚本随对应包维护。根 `package.json` 提供常用命令；脚本不保存用户会话数据。

- 官方插件的构建和单测由 `vykor-plugins` 仓库负责。宿主不再包含或准备这些插件的源码；需要跨仓库兼容性检查时，显式设置测试环境变量 `VYKOR_OFFICIAL_PLUGINS_DIR` 指向该仓库的 `plugins` 目录。
- `prepare-office-engine.mjs`：按宿主 Office 模块的固定摘要准备引擎并复制该模块的许可证；下载和缓存均独立于插件，不分发或安装插件。插件发行准备由独立的插件市场仓库负责。
- `check-docs.mjs`：检查根说明、全部 docs Markdown 和各模块 README 的链接与章节、当前源码入口、状态、总目录及协议版本声明。根 `pnpm check-docs` 先运行检查器回归测试，再扫描文档；`documentation-policy.mjs` 负责状态分类、协议版本比较和模块 README 收集。
- `sync-plugin-app-client.mjs`：从 `packages/plugins/src/app-client/client.ts` 生成独立插件使用的浏览器模块和类型声明；`--check` 核对示例、参考资产和天气模板中的副本，不改文件。
- `architecture-boundaries.mjs`：检查跨模块依赖和旧 Store 业务调用数量，`architecture-baseline.json` 只允许数量下降。仅精确路径 `packages/server/src/application/daemon-application.ts` 与 `packages/server/src/application/default-node-application.ts` 的 `store.close()` 属于组装根的数据库生命周期，不计入旧业务调用；同文件其他 Store 方法、其他文件的 `close()` 仍计数，Windows 路径分隔符先归一化。分类移出已有调用时等量降低基线，不保留新增业务调用余量。回归测试使用 `node --test scripts/architecture-boundaries.test.mjs`，覆盖精确路径、非根调用、业务方法和增长门禁。
- `pnpm check:retired-ui`：旧 UI 引用及实现退役检查，历史引用需在精确到行的登记表中注明原因。
- `verify-clean-slate.mjs` 与 `clean-slate-smoke.mjs`：检查发行契约及空环境启动，严格使用当前协议 7；协议升级时同步检查脚本和对应回归夹具，不能通过接受旧协议跳过门禁。

新增脚本按用途命名；只为某个插件服务的脚本放到该插件目录，新增测试放所属 `__test__/`。发行临时产物写入忽略目录，不与源码或运行数据混放。

`architecture-policy.mjs` 对指定测试驱动提供一条精确能力许可：只有 `packages/services/src/database/persistence/__test__/storage-growth.bench.mjs` 可以导入 `node:child_process` 的 `spawnSync` 来启动全新测量进程。该文件的其它禁用能力、普通生产 mjs、近似文件名及其它路径仍执行原有限制；不提供通用 `__test__` 或 `.bench.mjs` 豁免。这是门禁的一处明确规则变化，未提高旧调用基线，也未改变生产存储模块的能力边界。上述行为由 `architecture-boundaries.test.mjs` 的真实文件扫描测试验证。
