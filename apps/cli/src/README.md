# CLI 入口与命令

`index.ts` 只读取放在第一个参数位置的宿主 `--data-root` 参数并完成用户根选择，成功后动态加载 `program.ts`。后者注册 Commander 命令，将操作交给 `commands/` 与 daemon 控制模块。损坏定位记录或待恢复迁移会在业务模块导入前退出，错误写入标准错误流。

根选择状态由 `@vykor/host-config/paths` 持有，后台进程继承同一明确根；系统服务 invocation 写入 `--data-root`，重启不会重新选择另一根。维护命令应在 `index.ts` 的初始化之前分流，只使用只读选择与本机恢复接口，不能通过普通命令关闭保护。

新增命令放在 `commands/`；新的启动测试放在本目录 `__test__/`。界面入口是 `tui/`，daemon 进程管理继续放在现有 daemon 模块。

普通 `serve` 在默认应用创建数据库前也检查旧选库，不能通过省略 `--register` 或改为非本机监听绕过迁移要求。对应子进程回归在 `__test__/data-root-bootstrap.test.ts`，只使用临时根和临时 SQLite 文件，并核对旧库字节不变、默认空库未创建。

`data-root inspect/migrate/recover` 在初始化、写资格和 program.ts 导入前分流。inspect 只输出来源、清单、冲突、空间与重启影响，不创建目录。migrate 复用服务器整根协调；recover 从私有记录恢复，`recover --startup-lock` 仅处理没有 pending 的可核对死亡启动锁。命令与测试放在 [commands/](./commands/README.md)。
