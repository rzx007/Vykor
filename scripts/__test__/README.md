# 脚本回归测试

`prepare-office-engine.test.mjs` 在临时宿主目录运行真实准备脚本，验证下载、宿主缓存和许可证不依赖插件源码或插件二进制。夹具使用小文本代替程序，不下载真实引擎，也不接触用户数据。

入口为 `node --test scripts/__test__/prepare-office-engine.test.mjs`。新增跨包脚本测试放这里；模块内部测试放回对应模块。

`documentation-policy.test.mjs` 验证文档分类不会被交叉引用误导、旧协议版本声明会失败、模块 README 扫描会跳过安装依赖和构建产物。`pnpm check-docs` 自动运行这组测试，也可用 `node --test scripts/__test__/documentation-policy.test.mjs` 单独执行。
