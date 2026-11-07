# 本机后台连接

Node 主进程从 `@vykor/application-client/service` 使用 `Service`。它读取登记、探活并按调用方给出的命令启动进程，返回地址和 token。启动锁由 SDK 管理，业务状态由 daemon 保存。新的桌面进程管理逻辑留在桌面本机入口。
