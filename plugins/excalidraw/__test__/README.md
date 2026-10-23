# __test__

跨后台与页面协议的集成检查。`stdio.test.mjs` 启动构建后的 MCP 服务，验证资源、确认回执、去重、通知、局部操作和导出。先运行 `npm run build`，再运行 `npm run test:stdio`；测试数据在临时目录中创建并清理。
