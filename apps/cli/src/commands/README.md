# CLI 命令

命令参数在这里转换为应用调用，普通入口由 ../program.ts 注册，状态由对应应用服务持有，结果返回终端。新增命令及所属 __test__/ 放在本分类。

`data-root.ts` 在初始化与写资格之前提前路由。语法为 `vk data-root inspect --from <完整旧根> --to <完整目标根>`、同参数的 `migrate`、`recover --journal <完整记录路径>`，以及无记录的 `recover --startup-lock`。home 与原始环境来自本机，Desktop 宿主位置来自已核对收据。inspect 不写磁盘；migrate 使用同一服务器协调入口，恢复按记录核对身份，不提供 force 或通用解锁参数。子进程使用同安装入口及首位目标参数。
