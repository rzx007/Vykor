# Desktop 电脑操作测试

[`ipc.test.ts`](ipc.test.ts) 验证主窗口来源和页面离开后的撤权。[`computer-bridge.test.ts`](computer-bridge.test.ts) 用真实本机 HTTP 流和假宿主验证授权头、一次提交、结果、断线、重新连接、私有审批，以及 Stop 后旧请求失效且新任务继续。测试状态仅留在本次运行的进程内。

[`daemon-pairing.test.ts`](daemon-pairing.test.ts) 验证按需后台重新配对时保留有任务或临时聊天的后台，并在本机端口被新进程复用时撤销旧凭证。

[`interaction.test.ts`](interaction.test.ts) 验证唯一目标直接返回，多个目标只能回复本次列出的候选。取消或断线后旧选择无效，只有在当前窗口明确选择始终允许才保存权限。

[`computer-host.test.ts`](computer-host.test.ts) 验证复用、授权后启动、跨应用接续、归属明确的对话框、目标改变和已保存许可撤销。[Windows 实机集成入口](../../../../../../../tests/desktop-integration/README.md) 用真实系统应用与受控 WinForms 夹具验收。

[`computer-semantics.test.ts`](computer-semantics.test.ts) 验证控件引用、文本及选择滚动读回、高影响操作的单次审批、审批期间换窗和撤权。

[`windows-driver.test.ts`](windows-driver.test.ts) 验证 Windows 辅助功能接口确认的控件和值才进入观测，Cua 返回的同进程其他窗口数据不能成为写入目标。清空文本需要 Windows 明确读回空值。

[`windows-foreground.test.ts`](windows-foreground.test.ts) 验证截图坐标换算，拒绝缺少签名或超出画面的点击，并检查跨窗口系统快捷键不会作为前台动作执行。[`windows-foreground-live.test.ts`](windows-foreground-live.test.ts) 使用两个同名 WinForms 窗口，核对实际截图、失焦和外部输入接管。还检查同一窗口切换焦点后的旧按键、窗口归属变化，以及嵌入认证控件后的截图和语义操作。测试真实卸载输入观察钩子，验证两个窗口均未收到新按下事件。测试专用闸门分别在键盘和鼠标的抬起入队前等待 Stop，核对原窗口随后收到一次对应释放且控制进程已退出。另测启动许可发送前取消时保留当前前台窗口。

从仓库根目录运行 `pnpm --filter @vykor/desktop exec vitest run src/main/features/computer`。

在已解锁的 Windows x64 交互桌面复跑原生前台实机用例：

```powershell
$env:VYKOR_WINDOWS_FOREGROUND_LIVE = '1'
pnpm --filter @vykor/desktop exec vitest run src/main/features/computer/__test__/windows-foreground-live.test.ts
Remove-Item Env:VYKOR_WINDOWS_FOREGROUND_LIVE
```
