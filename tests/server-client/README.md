# 服务端与客户端贯通测试

这里通过真实 HTTP 路由、客户端、应用与临时 SQLite 检查共同契约。旧测试入口在本目录，新增测试放 `__test__/`；`vitest.config.ts` 由根配置派生，`tsconfig.json` 检查两处测试。

`__test__/data-root-discovery.test.ts` 使用离线模型、真实 CLI 验证子进程和 Node SDK，验证连续两次迁移、默认发现、正式会话继续、历史文件访问以及临时正文不落库。共用的临时目录/应用帮助代码放在 `../helpers/data-root-fixture.ts`，每例负责关闭自己创建的后台和文件。

运行 `pnpm test:server-client`；根 `pnpm test` 已包含它。测试不访问真实用户数据或付费模型。其它关键契约见[测试索引](../../docs/contract-test-index.md)。
