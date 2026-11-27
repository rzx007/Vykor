# 电脑操作

[`computer-interaction.tsx`](computer-interaction.tsx) 在桌面根页面订阅主进程的请求。应用授权进入所属聊天输入框上方的[待处理卡堆](../../conversation-page/message/blocks/permission-stack.tsx)。默认允许范围是当前任务。用户也可以勾选针对该应用的长期授权，在点击允许后生效。回复原请求后继续同一步。

[`computer-interaction-dialog.tsx`](computer-interaction-dialog.tsx) 负责需要用户选择的目标。断线或操作取消后，主进程通知界面撤下对应请求。主进程核对应用授权和目标有效性。新增电脑操作的界面交互放在本目录，授权列表在[电脑控制设置](../../settings-page/computer/README.md)管理。

[`computer-activity-panel.tsx`](computer-activity-panel.tsx) 负责输入框工具栏的电脑操作选项。打开后可预览当前窗口、关闭截图、暂停、继续或停止。操作带上当前会话及运行的标识，由主进程再次核对。暂停、切换会话或停止会清除预览。键鼠释放和截图撤回的回执在选项里查看。
