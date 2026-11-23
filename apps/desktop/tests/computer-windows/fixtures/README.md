# 实机测试夹具

[`Fixture.cs`](Fixture.cs) 是会显示两个同名窗口的 Windows 测试应用。它用自己的事件日志记录文本、点击、键鼠释放、延迟动作和窗口实例。
用测试快捷方式无参数启动时，它显示两个同名测试文档。测试通过专用临时目录要求另一个窗口改名或打开一个有明确所属窗口的对话框，再核对夹具日志。 [跨包实机入口](../../../../../tests/desktop-integration/README.md)

前台实机测试可写入 `focus.request` 让夹具激活其中一个窗，或写入 `external.request` 使夹具在指定窗确实在前台时产生一对 F9 事件。两个请求都只认 `target` 和 `control`。夹具日志分别记录按钮坐标、键鼠按下与释放以及实际收到动作的窗口。前台测试使用助手内的同步点确认释放仍未入队，再用夹具的日志独立核对 Stop 送达的释放。 [前台测试说明](../../../src/main/features/computer/__test__/README.md)
[`ProbeWindows.cs`](ProbeWindows.cs) 提供真实应用测试所用的只读窗口身份核对。
两者由 [测试入口](../__test__/README.md) 编译、启动，程序和日志都落在本次测试的临时目录。新增专用测试窗或只读 Windows 探针放在这里。
