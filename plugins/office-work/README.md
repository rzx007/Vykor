# office-work：演示文稿

独立原生插件，首版仅支持 Windows x64。四个工具：OfficePptCreate、OfficePptRead、OfficePptEdit、OfficePptCheck。OfficeCLI v1.0.139 随 ZIP 打包，运行时不联网、不安装依赖。

支持可编辑文字、基础形状、表格及工作区 PNG/JPEG；修改只支持元素文字与基础样式。不包含 Word/Excel/PDF、旧格式、图表、页增删重排、复杂模板、自动渲染审查。用户已有文件另存；插件成果以摘要检查后继续修改。结构验证不等于 PowerPoint/WPS 保真或视觉验收。

0.1.1：表格默认 16pt、按内容估算行高，支持列宽与行高设置，放不下时要求精简或拆页；同文件调用有期限地等待而非立即报争锁；读取与检查只在工作副本运行；发现 Office 占用标记时明确提示关闭文件。不会自动修改已生成的 PPT，也不会清理旧的失败工作目录。

0.1.2：给关闭与删除工作副本预留时间；关闭命令每次最多 4 秒，最多两次尝试，仍受宿主调用期限限制。保留原始操作错误，不让清理错误覆盖它。未确认关闭时保留当前临时副本并报告路径；文件已保存但临时目录删除失败时返回实际成果和清理警告，不冒充文件保存失败。不会扫描或删除之前留下的目录。

0.2.0：进程调用、版本校验和取消处理改为复用应用公共 Office 引擎代码；插件仍保留自己的文件锁、工作副本和成果记录。应用内置 `.docx/.xlsx/.pptx` 上传、解析及只读预览，插件的四个 PPT 工具范围仍限 PPTX。

Windows PowerShell 构建：`powershell -ExecutionPolicy Bypass -File plugins/office-work/scripts/build.ps1`。下载固定版本并核对 SHA256，统一输出 `apps/desktop/out/bundled-plugins/office-work.zip`。导入此 ZIP，新建会话选择“演示文稿”。二进制不提交 Git。

测试：先构建准备引擎，再 `node --test plugins/office-work/test/*.test.mjs`。真实引擎测试在临时目录运行，不修改用户材料。

成果在当前工作区；内部当前成果记录在稳定 plugin.dataDir/presentations。仅允许工作区内路径，声明文件读写和 officecli 进程权限。该权限声明不是操作系统沙箱。异常退出遗留 `.office-work.lock` 时，先确认相应操作与引擎已退出，再人工移除对应锁；工具不会自动抢锁覆盖。

设计参考 Orkas 的 PPT 工作流程与 OfficeCLI 适配经验，采用独立实现；相关许可见 THIRD-PARTY-NOTICES.md。
