# 构建、校验与测试

`build.mjs` 是跨平台发行入口：先校验四份官方技能和许可，从仓库公共 Office 模块读取固定版本及六平台摘要，下载或复用已校验缓存，最后复制公共模块到插件工具目录。输出留在插件的 `bin/` 与 `tools/office-engine.mjs`，交由市场生成 ZIP，不创建桌面应用产物。

`verify-official-skills.mjs` 同时支持源码目录、无顶层 ZIP 和市场的单顶层目录 ZIP，检查入口、完整正文、版本来源、Git blob 与 SHA-256。`release-archive.mjs` 只展开归档内需要核验的小文本，限制整个归档为 100 MiB 压缩、250 MiB 展开，拒绝混合根目录，不改变 Office 用户文件的原有读取限制。

`test.mjs` 先离线复制公共引擎模块，再运行 `test/` 和 `__test__/` 的测试；默认不执行真实引擎用例，`--native` 在 Windows x64 启用原生测试。`build.ps1` 保留 Windows 命令入口，转调同一 Node 构建。

下载缓存属于构建机器；插件 dataDir、用户文档、工作副本与检查历史由运行工具管理，本目录不清理它们。新增构建校验放本目录，跨文件发行回归测试放 `../__test__/`。
