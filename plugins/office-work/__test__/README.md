# 发行回归测试

`release-build.test.mjs` 使用临时目录和小型下载响应验证真实构建函数：缓存摘要、坏下载拒绝、缓存复用、公共引擎模块复制。`release-skills.test.mjs` 生成临时 ZIP，验证大于 Office 文档读取限制的通用插件仍能检查官方技能，兼容市场的单顶层目录，并拒绝正文变动和竞争根目录。

入口为 `npm test`，也可在仓库根执行 `node --test plugins/office-work/__test__/*.test.mjs`。不下载真实程序，不接触插件 dataDir；临时夹具在测试结束后删除。已有文档编辑、恢复与预览测试保留在 `../test/`。
