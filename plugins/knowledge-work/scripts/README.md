# 发行准备

`build.mjs` 是 `npm run build` 的入口，从插件根读取 package.json 与 manifest，检查版本、LICENSE、角色和技能目录，再加载每个工具入口确认能注册。纯 Node 实现无需编译或下载，检查通过后由插件市场生成归档。

这里不读写插件运行数据；来源和请求账本仍由 `tools/` 保存到宿主提供的 dataDir。新增发行检查放本目录，离线回归测试放插件根的 `__test__/`。
