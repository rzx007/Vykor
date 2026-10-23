# Office 工具

manifest 从 `index.mjs` 注册 `OfficeCLI` 与九个 Check／Preview／Review 工具。`official-cli.mjs` 将已验证的参数交给 `engine.mjs`；后者根据系统和架构选择插件 `bin/` 中的程序，由构建复制的 `office-engine.mjs` 检查摘要并直接启动进程。

`file-access.mjs` 与 `working-file.mjs` 限制工作区路径、串行处理同一文件并管理私有副本；`lock-recovery.mjs` 恢复已登记且无人持有的副本。`scope-check.mjs`、`page-diff.mjs` 与 Excel 系列模块检查修改范围和文件内容；`preview.mjs`、`word-page-image.mjs` 和 `visual-review.mjs` 处理预览和版本绑定的检查记录。

用户成果归用户工作目录，检查历史归宿主提供的 plugin dataDir，程序与代码归插件安装目录。市场升级只替换安装文件，不由构建迁移或删除运行数据。新增工具实现放本目录，已有测试在 `../test/`，新增本模块测试放 `__test__/`。
