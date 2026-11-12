# 桌面主进程

`index.ts` 保留 Electron 就绪前必须执行的协议注册与 Linux 启动参数，然后初始化用户数据根；只有成功后才动态加载 `application.ts`。协议模块只持有内存文档映射，不读取业务数据目录。

`application.ts` 按无窗口 daemon 模式或普通窗口模式分流，创建应用上下文、业务服务与窗口。用户根选择由 host-config 在当前进程内固定；子进程继承同一根，系统服务启动参数明确传入 `--data-root`。迁移定位损坏时启动直接停止，不创建新数据库。Electron 外壳 userData 仍由 Electron 管理。

通用启动能力放在 [core/](./core/README.md)，按业务分类的能力放在 `features/`。跨模块启动测试放在本目录 `__test__/`，功能测试放在所属分类。
