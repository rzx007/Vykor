# 桌面终端

`ipc.ts` 接收窗口的终端创建、输入、尺寸和关闭请求。`terminal-service.ts` 管理窗口订阅以及连接替换，经 `terminal-resource.ts` 调用已认证的后台终端接口。终端输出通过持续的 HTTP 数据流返回主进程，再送到订阅窗口。

后台管理终端进程和终端状态，主进程保存窗口对应的订阅。`detect-shells.ts` 查找本机可用的 Shell，`apply-preferred-shell.ts` 应用用户偏好。新增终端操作放在本目录，新测试放在 `__test__/`。
