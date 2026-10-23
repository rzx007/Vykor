# 本机后台服务管理

公开入口为 `@vykor/client/service`，仅在 Node.js 中使用。浏览器入口不导入这里。

| 文件 | 用途 |
| --- | --- |
| `index.ts` | 导出 `Service`、独立函数和参数类型 |
| `registry.ts` | 定位、读取和校验 daemon 登记文件，比较实例身份 |
| `process.ts` | 从调用方项目定位 CLI，直接启动可执行程序，清理启动失败的子进程 |
| `startup-lock.ts` | 按登记文件取得跨进程启动锁，防止多个应用重复启动 |
| `service.ts` | 查找、协议与鉴权检查、共享启动、精确实例停止 |

调用顺序为 `Service.ensure()` → `Service.clientOptions(endpoint)` → `new VykorClient(...)`。业务状态始终由 daemon 保存；本模块保存当前进程中尚未结束的启动 Promise，并通过登记文件旁的 `.sdk-start.lock` 目录协调不同进程。锁使用固定的 10 秒失效期和 5 秒续期，启动过程结束即释放。登记文件沿用 daemon 格式与 `VYKOR_CONFIG_DIR` / `VYKOR_DATA_DIR` 位置。

默认启动命令使用调用方项目安装的 `@rzx/ohs`。自定义命令必须写入所选登记文件；不会执行 shell 字符串，也不修改操作系统自启动设置。发现活着但不兼容的服务时报告错误，由调用者明确处理。

新增管理逻辑放在对应文件，回归测试放在 `__test__/`。测试使用临时目录和独立 Node 子进程，不操作用户 daemon。
