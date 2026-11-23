# Desktop 跨包集成测试

这里验证真实模型流解析、Agent 执行、SQLite 事件投影与 Desktop 订阅和展示之间的配合。Desktop 包内继续测试订阅合并、确认、恢复和客户端展示；同时调用 Core、Runtime、工具和 Server 的完整流程放在本目录的 `__test__/`。

- `__test__/session-write-generation.test.ts`：暂停 Write 参数流，检查界面先显示生成状态、此时尚未写文件；恢复后只执行和展示一次正式工具调用。
- `__test__/data-root-migration.test.ts`：贯通真实旧数据集分类、renderer 草稿导入、主进程业务存储和同根失败恢复，检查临时正文过滤、原输入 ID、两次恢复、更新后的草稿及壳偏好保留。这里使用 jsdom 的 localStorage，不冒充真实 Electron profile 导出验收。
- `__test__/notes-backup.test.ts`：用真实 SQLite 和 Markdown 校验桌面统一备份及旧版恢复，检查会话、便签修订与原备份哈希。
- `__test__/computer-bridge.test.ts`：使用实际 Desktop 与 daemon HTTP 桥、离线模型和假窗口操作，核对工具结果、截图撤权，以及首步前切走并切回后旧任务零派发。
- `__test__/computer-windows-live.test.ts`：在 Windows x64 交互会话中用注册入口启动计算器、画图和测试夹具，核对跨应用接续、已有文档复用、同名选择和归属已验证的对话框。这个用例显式开启后才运行。
- `__test__/computer-windows-semantic-live.test.ts`：用签名 Cua 驱动、真实记事本及 WinForms 夹具，验证控件、文本读回、私有审批和 Stop。模型由本地测试脚本驱动，无需 API 密钥。这个用例显式开启后才运行。
- `__test__/computer-windows-foreground-live.test.ts`：从可信聊天经 daemon 和 Desktop 私有桥启动 Windows 计算器，核对截图、前台按键和结束释放。用 WinForms 在键盘和鼠标的抬起尚未入队时走聊天 Stop，核对两次都只向原窗口补发一次释放。`__test__/windows-live-fixture.ts` 注册测试夹具，`__test__/windows-live-cleanup.ts` 只关闭能核实为测试启动的窗口。
- `vitest.config.ts`：沿用 Desktop 的别名、转换插件和隔离配置，React 从 Desktop 已声明的依赖解析，避免给根包增加界面依赖。

运行 `pnpm test:desktop-integration`。根 `pnpm test` 已包含此命令，普通 CI 继续覆盖。默认用例使用离线流、临时 SQLite 与临时文件。Windows 实机用例也使用离线流。

在 Windows x64 普通交互会话中确认计算器和画图当前关闭，随后运行以下命令。脚本会自行启动应用，在测试期间注册一个专用开始菜单快捷方式并在结束时移除它。

```powershell
$env:VYKOR_COMPUTER_WINDOWS_LIVE = '1'
pnpm exec vitest run --config tests/desktop-integration/vitest.config.ts tests/desktop-integration/__test__/computer-windows-live.test.ts
Remove-Item Env:VYKOR_COMPUTER_WINDOWS_LIVE
```

语义操作验收也需在 Windows x64 的已解锁交互会话运行。先按 [Windows 驱动准备说明](../../apps/desktop/tests/computer-windows/README.md) 验证驱动，再运行：

```powershell
$env:VYKOR_COMPUTER_WINDOWS_SEMANTIC_LIVE = '1'
pnpm exec vitest run --config tests/desktop-integration/vitest.config.ts tests/desktop-integration/__test__/computer-windows-semantic-live.test.ts
Remove-Item Env:VYKOR_COMPUTER_WINDOWS_SEMANTIC_LIVE
```

阶段 5 在 Windows x64 的已解锁交互会话运行。计算器测试会自己启动目标。使用 WinForms 夹具检查真实键鼠、换窗与释放的方法见 [Windows 实机测试目录](../../apps/desktop/src/main/features/computer/__test__/README.md)。

```powershell
$env:VYKOR_COMPUTER_WINDOWS_FOREGROUND_LIVE = '1'
pnpm exec vitest run --config tests/desktop-integration/vitest.config.ts tests/desktop-integration/__test__/computer-windows-foreground-live.test.ts
Remove-Item Env:VYKOR_COMPUTER_WINDOWS_FOREGROUND_LIVE
```

要核对包内驱动，先验证已解包的资源目录，再将其绝对路径设为 `VYKOR_COMPUTER_TEST_RESOURCES`。计算器用例会从该目录启动驱动、读取控件树，再验收前台输入和截图。
