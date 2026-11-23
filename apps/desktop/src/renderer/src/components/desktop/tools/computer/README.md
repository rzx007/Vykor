# 电脑操作

[`computer-interaction.tsx`](computer-interaction.tsx) 在桌面根页面订阅主进程的请求。应用授权复用 Approval 卡片，按会话标识显示在对应聊天的消息区底部。应用授权按当前任务范围提供「仅本任务」和「始终允许」选择。选项回复原请求后继续同一步。

[`computer-interaction-dialog.tsx`](computer-interaction-dialog.tsx) 负责需要用户选择的目标。断线或操作取消后，主进程通知界面撤下对应请求。主进程核对应用授权和目标有效性。新增电脑操作的界面交互放在本目录，授权列表由运行设置维护。

[`computer-activity-panel.tsx`](computer-activity-panel.tsx) 负责输入框工具栏的电脑操作选项。打开后可预览当前窗口、关闭截图、暂停、继续或停止。操作带上当前会话及运行的标识，由主进程再次核对。暂停、切换会话或停止会清除预览。键鼠释放和截图撤回的回执在选项里查看。
