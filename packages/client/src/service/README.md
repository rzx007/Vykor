# 本机后台服务管理

公开入口为 `@rzx/client/service`，仅在 Node.js 中使用。浏览器入口不导入这里。

| 文件 | 用途 |
| --- | --- |
| `index.ts` | 导出 `Service`、独立函数和参数类型 |
| `registry.ts` | 定位、读取和校验 daemon 登记文件，比较实例身份 |
| `process.ts` | 从调用方项目定位 CLI，直接启动可执行程序，清理启动失败的子进程 |
| `startup-lock.ts` | 按登记文件取得跨进程启动锁，防止多个应用重复启动 |
| `service.ts` | 查找、协议与鉴权检查、共享启动、精确实例停止 |

调用顺序为 `Service.ensure()` → `Service.clientOptions(endpoint)` → `new VykorClient(...)`。业务状态始终由 daemon 保存；本模块保存当前进程中尚未结束的启动 Promise，并通过登记文件旁的 `.sdk-start.lock` 目录协调不同进程。锁使用固定的 10 秒失效期和 5 秒续期，启动过程结束即释放。登记文件沿用 daemon 格式与 `VYKOR_CONFIG_DIR` / `VYKOR_DATA_DIR` 位置。

调用方可以通过 `logPath` 保存新启动进程的标准输出和错误。默认启动命令使用调用方项目安装的 `@rzx/ohs`。自定义命令必须写入所选登记文件；不会执行 shell 字符串，也不修改操作系统自启动设置。发现活着但不兼容、暂时不可达或正在安全重启的服务时，启动操作报告错误，由调用者重试或明确处理。

启动期间，健康检查、协议协商和鉴权共用剩余的启动期限，不受普通发现操作默认 1 秒期限限制。Windows 首次能力查询可能需要等待运行环境检测；超过总期限或取消启动时，仍会关闭请求并清理本次创建的子进程。

新增管理逻辑放在对应文件，回归测试放在 `__test__/`。测试使用临时目录和独立 Node 子进程，不操作用户 daemon。

Node 服务发现通过 `@vykor/host-config/paths` 的轻量模块共享产品根选择，按调用者传入的 env、固定定位记录、默认根定位。`discover({ env })` 与 `ensure({ env })` 使用同一规则；损坏、迁移中或找不到已选数据库时拒绝启动。`ensure` 把同一根及 home 传给子进程。该工作区引用只用于构建并内联，不增加发布依赖；浏览器入口不导入它。

`ensure` 遇到正常根初始化锁时，在调用者的同一个总 deadline 和 AbortSignal 内等待并重新校验；并发加入者有自己的等待期限，不取消原启动者。显式 env 未提供 home 时使用系统账户 home，不读取全局 HOME/USERPROFILE。

默认服务启动先在 home 锁中重验并取得 `sdk-control` 写资格，再等待 registry 控制锁；清理和释放不反向等待 home。默认 discover/ensure 返回的 endpoint 保存本次来源，stop 在停止及清理 registry 前重新登记。显式 file 的调用者管理契约不被全局 root 或无关环境覆盖。迁移遇到现有 SDK 控制者会报告忙；不会持有 home 再等该控制者。

显式 file 与正常选择的 canonical registry 相同时，省略 command 仍可启动调用方安装的默认 CLI；复用已有服务时同样接受 pending 等根保护，并给 stop 保留管理来源。独立显式 file 的已有健康服务可以直接复用，无需 command，也不受无关 selector 或 pending 阻止。显式 file 加自定义 command 始终保持调用者管理，即使路径碰巧等于 canonical registry，也不读取无关 selector 或登记根写资格。共享同一次启动的调用者分别取得自己的 endpoint 对象，管理来源只属于本次调用，不互相改变 stop 的管理边界。ensure 和 stop 的 home 写资格等待传递原 AbortSignal 与同一绝对 deadline；私有目录准备、取锁和资格写入后均检查剩余期限，取消完成前清理本次资格，不留后台等锁任务。stop 的鉴权和退出等待也共用这一期限。
