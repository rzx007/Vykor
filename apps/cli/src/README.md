# CLI 入口与命令

`index.ts` 只读取放在第一个参数位置的宿主 `--data-root` 参数并完成用户根选择，成功后动态加载 `program.ts`。后者注册 Commander 命令，将操作交给 `commands/` 与 daemon 控制模块。损坏定位记录或待恢复迁移会在业务模块导入前退出，错误写入标准错误流。

根选择状态由 `@vykor/host-config/paths` 持有，后台进程继承同一明确根；系统服务 invocation 写入 `--data-root`，重启不会重新选择另一根。维护命令应在 `index.ts` 的初始化之前分流，只使用只读选择与本机恢复接口，不能通过普通命令关闭保护。

新增命令放在 `commands/`；新的启动测试放在本目录 `__test__/`。界面入口是 `tui/`，daemon 进程管理继续放在现有 daemon 模块。
