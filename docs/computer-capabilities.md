# Desktop 电脑操作

> 状态：当前实现，Windows x64 试点。阶段 5 已完成实机验收，签名安装包与真实模型的结果见接入计划。

在 Windows x64 的 Vykor 主聊天启用「电脑操作」再发送任务。Vykor 查找 Windows 已登记的应用，启动或复用窗口。首次使用需同意应用许可，多个窗口符合时由用户选择。可以在「运行设置」撤销保存过的许可。切换或隐藏主聊天后，旧任务的电脑操作许可失效。

Windows x64 安装包包含固定版本的控制驱动。已打包的 Vykor 默认关闭电脑操作。试点时以 `VYKOR_COMPUTER_USE=1` 启动，驱动资源完整时显示入口。以 `VYKOR_COMPUTER_USE=0` 启动可以停用。开发模式在本地预置驱动就绪后默认显示入口。

## 已验证范围

- **应用和窗口**。计算器、画图和测试窗口可以从系统登记启动。记事本支持自动打开隔离窗口及多行编辑。窗口有歧义时等待选择。 [应用发现实机](../tests/desktop-integration/__test__/computer-windows-live.test.ts) · [记事本实机](../tests/desktop-integration/__test__/computer-windows-semantic-live.test.ts)
- **控件和读回**。应用公开的按钮、编辑框、选择和滚动可按控件身份操作。写入或选择可按返回值核对，按钮根据界面变化报告结果。确认保存需重新打开文件，或读取获准的位置。 [操作方式](../apps/desktop/src/main/features/computer/README.md)
- **截图与前台输入**。可按需截图，预览限于当前聊天。获取前台许可后可按键、输入文字和点击，坐标需要最新画面。计算器和 WinForms 通过实机验证。自绘控件、依赖系统硬件键态的快捷键及 Windows 安全对话框可能需要人工操作。 [前台实机](../tests/desktop-integration/__test__/computer-windows-foreground-live.test.ts)

## 遇到问题时

- 找不到应用时，核对开始菜单名称。多个窗口符合时，在候选列表选择。目标不明时任务等候复核。
- 高影响操作逐次批准。密码及系统安全界面由用户处理。暂停后可手动接管，继续时重新核对和观察窗口。
- 点聊天「停止」或按 `Ctrl+Alt+Shift+Esc` 撤销本轮授权。应用已收到的动作可能继续。结果待确认时先重新观察。
- 截图可在聊天关闭。已发出的截图无法撤回，模型重试只使用文字。 [图片边界](../packages/server/src/application/computer-tools/README.md)
- 缺少驱动时入口不可用。运行中校验不通过时，重新安装已核验的安装包。升级、重启或切换数据目录后需要重新授予任务许可。 [安装包核验](../apps/desktop/docs/packaging.md)

公开启用前需完成签名安装包、真实模型、实体输入和安装生命周期的试点验收。 [接入计划](./superpowers/plans/2026-11-22-windows-computer-use-integration.md)
