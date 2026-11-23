# Windows Computer Use 实机验证

这个目录验证 Vykor 计划使用的 Windows 路径。入口在 [`__test__/`](__test__/README.md)。
[`cua-direct.mjs`](cua-direct.mjs) 用 Desktop 已有的 MCP 客户端经专属标准输入输出连接 Cua。
每个驱动实例从启动起使用独立临时目录、关闭遥测和更新检查，并读取只允许指定进程 ID、窗口句柄和工具的清单。窗口句柄是 Windows 为当前窗口分配的标识。
夹具的按钮次数、输入值和输入事件由夹具进程写到临时目录。真实应用的验证依据是测试文件字节和重新打开后读取的编辑器内容。
新增实机用例放在 `__test__/`，用例进程和只读窗口探针放在 [`fixtures/`](fixtures/README.md)。

## 运行

使用有桌面的 Windows x64 普通交互账号，提前安装仓库依赖。在 PowerShell 从仓库根目录运行：

```powershell
node scripts/prepare-cua-driver.mjs
$driver = (Resolve-Path apps/desktop/out/computer-windows/x64/cua-driver.exe).Path
node apps/desktop/tests/computer-windows/__test__/direct-fixture.mjs $driver
node apps/desktop/tests/computer-windows/__test__/real-apps.mjs $driver
```

实机脚本依次运行，前台输入会切换到本次测试的窗口。要验收冷启动，在没有运行记事本的交互会话执行真实应用脚本。已有待保留的标签页时，可加 `--allow-running-notepad` 复跑保存与读回链路。结果输出到脚本报告的临时目录。

## 2026-11-23 实机结果

Windows x64，系统构建 26300，Cua 0.28.2，记事本 11.2609.11.0。

- **窗口限域。** 两个夹具窗口共用进程和标题。只许可其中一个，另一个拒绝读取和点击。宿主用新观察替换原观察后，原控件引用被拒绝。窗口重建后，旧句柄失效，新句柄需要新清单。
- **观察和动作。** Cua 后台点击、赋值、读回成功，另一个窗口保持前台。成功获取目标窗口的 PNG。将测试窗口明确移到前台后，夹具日志分别记录左鼠标键和 F8 的按下、释放。
- **冷启动和跨应用。** 从没有记事本进程开始，通过 Windows 注册入口打开测试文件。记事本恢复了之前的标签页，于是通过菜单在新窗口中编辑专用测试内容。数据通过编辑器的结构化接口写入和读回，经菜单进入归属已核对的「另存为」对话框。磁盘读回 77 字节，文本与预期一致。关闭这次保存的文档后，资源管理器对测试目录中唯一的文件执行控件操作。记事本重新打开该文件，编辑器读回再次一致。仓库脚本用另一个临时目录复跑了已有记事本实例时的同一操作链。
- **当前输入限制。** 「另存为」的文件名控件拒绝直接赋值，前台目标校验也拦截了未到前台时的输入。将确定归属的对话框带到前台后，使用键盘选择并输入文件名。保存动作回包标为效果待确认，通过文件字节核验才确认完成。生产中的前台占用与接管按阶段 5 验收。
- **停止。** 结束 Cua 会话后，新的测试动作被拒绝。标准输入输出关闭后，测试驱动及其子进程没有残留。一个已交给夹具的延迟动作仍然完成。紧急停止时的按键释放、断线、失焦和接管走阶段 5 的独立验收。
- **解包。** 使用 electron-builder 26.15.3 按项目 Windows 资源配置生成最小 x64 解包产物，验过驱动摘要、x64 架构、Cua 厂商签名和许可证。Cua 原厂签名由构建中的排除规则保留。当前本机已有的 Vykor 程序及安装器样本未签名，正式 Vykor 签名凭据和签名安装包验收仍是阶段 6 的交付。

最小解包使用现有 Windows 资源配置与本地 Electron 运行文件，应用入口只负责退出。
按 Desktop 的正常打包流程生成 `win-unpacked` 后，复核随包驱动的原厂签名、摘要、架构和许可证：

```powershell
node apps/desktop/scripts/verify-cua-packaging.mjs --artifact apps/desktop/dist/win-unpacked/resources
```

[阶段计划](../../../../docs/superpowers/plans/2026-11-22-windows-computer-use-integration.md) ·
[驱动准备与许可证](../../resources/computer-windows/README.md)
