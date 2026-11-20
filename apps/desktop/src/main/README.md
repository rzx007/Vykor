# 桌面主进程

`index.ts` 保留 Electron 就绪前必须执行的协议注册与 Linux 启动参数，然后初始化用户数据根；只有根初始化和旧独立目录覆盖检查成功后才动态加载 `application.ts`。协议模块只持有内存文档映射，不读取业务数据目录。

`application.ts` 按无窗口 daemon 模式或普通窗口模式分流，创建应用上下文、业务服务与窗口。用户根选择由 host-config 在当前进程内固定；子进程继承同一根，系统服务启动参数在其他参数之前明确传入 `--data-root`（开发模式在 Electron 应用路径之后）。迁移定位损坏时启动直接停止，不创建新数据库。Electron 外壳 userData 仍由 Electron 管理。

通用启动能力放在 [core/](./core/README.md)，按业务分类的能力放在 `features/`。跨模块启动测试放在本目录 `__test__/`，功能测试放在所属分类。

工作目录相关入口：会话分配与分类见 [features/session/](./features/session/README.md)，文件访问与系统打开见 [features/workspace/](./features/workspace/README.md)，技能页面的项目过滤见 [features/skill/](./features/skill/README.md)，Git 任务目录偏好与登记见 [features/settings/](./features/settings/README.md)。

`data-root-maintenance.ts` 是 `Vykor data-root` 的受限维护窗口；发现根外旧覆盖或旧选库记录时也进入这里，普通 application、预算和自启不启动。先核对真实旧数据集，用可信旧 daemon 或停写 DB/WAL 副本分类，再只注册业务导出和整根维护。`data-root-recovery-entry.ts` 在初始化与业务导入前处理 `data-root recover --journal <完整记录>` / `--startup-lock`；pending 故障窗口也能进入同一路径，不创建另一份空库。renderer 为 `../renderer/src/data-root-maintenance.tsx`，受限桥接见 [../preload/](../preload/README.md)。新增启动控制及测试继续放在本目录，业务状态由 business-data 和服务器记录持有。

普通启动在加载 application 前也检查 host 写入的未消费 legacySources：即使用户已清掉旧环境 pin，仍进入受限维护而不会创建新空库。来源实际恢复与身份核对由服务器只读预检完成；字段不通过 renderer 输入。
