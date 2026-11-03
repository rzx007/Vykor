# 桌面后台服务启动

负责桌面常驻服务、看护进程和已有服务的接管判断。公开接口经 `@vykor/server/daemon-host` 访问，桌面不直接依赖内部运行时。

- `daemon-entry.ts` 识别 service / watchdog 启动模式。watchdog 启动独立服务进程；service 核对登记信息、启动 daemon 并保存登记记录，退出时关闭服务。
- service 在构造 daemon 前把 `app.getPreferredSystemLanguages()[0]` 交给共享回复语言入口，使用系统首选显示语言，而不是日期或数字的区域格式。语言仅保存在进程中，不新增持久设置或 IPC。
- `daemon-autostart-service.ts` 管理桌面常驻开关；`daemon-takeover.ts`、`daemon-surface.ts` 处理服务归属与接管边界；`ipc.ts` 注册界面入口。

相关状态归宿主服务登记和已有桌面偏好所有。测试放在各被测文件旁，覆盖启动路由、健康检查和语言初始化顺序；新增后台服务启动行为继续放本目录。
