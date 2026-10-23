# Desktop 跨包集成测试

这里验证真实模型流解析、Agent 执行、SQLite 事件投影与 Desktop 订阅和展示之间的配合。Desktop 包内继续测试订阅合并、确认、恢复和客户端展示；同时调用 Core、Runtime、工具和 Server 的完整流程放在本目录的 `__test__/`。

- `__test__/session-write-generation.test.ts`：暂停 Write 参数流，检查界面先显示生成状态、此时尚未写文件；恢复后只执行和展示一次正式工具调用。
- `vitest.config.ts`：沿用 Desktop 的别名、转换插件和隔离配置，React 从 Desktop 已声明的依赖解析，避免给根包增加界面依赖。

运行 `pnpm test:desktop-integration`。根 `pnpm test` 已包含此命令，普通 CI 继续覆盖。测试使用离线流、临时 SQLite 与临时文件，不启动桌面应用或访问真实模型。
