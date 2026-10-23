# 桌面脚本回归测试

`verify-office-packaging.test.mjs` 在临时目录运行真实打包检查，验证宿主自己的 OfficeCLI 许可证及错误许可证的拒绝结果。不启动桌面界面，不需要插件目录或真实程序。

入口为 `node --test apps/desktop/scripts/__test__/verify-office-packaging.test.mjs`。新增桌面发行脚本的测试放这里。
