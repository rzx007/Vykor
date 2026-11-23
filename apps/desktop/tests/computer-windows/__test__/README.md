# Windows 实机测试入口

[`direct-fixture.mjs`](direct-fixture.mjs) 启动同名窗口测试应用，比较驱动结果和应用独立记录。
[`real-apps.mjs`](real-apps.mjs) 使用专用测试文件验证记事本启动、另存和资源管理器重新打开。
两者接收已验签的驱动路径，专用清单与证据保存在临时目录。新增 Windows 实机回归放在这里。 [准备与运行](../README.md)
