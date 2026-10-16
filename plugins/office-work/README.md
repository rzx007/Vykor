# office-work：演示文稿

独立原生插件，首版仅支持 Windows x64。六个工具：OfficePptCreate、OfficePptRead、OfficePptEdit、OfficePptCheck、OfficePptPreview、OfficePptReview。OfficeCLI v1.0.139 随 ZIP 打包，不自动安装依赖。

支持可编辑文字、基础形状、表格及工作区 PNG/JPEG；修改只支持元素文字与基础样式。不包含 Word/Excel/PDF、旧格式、图表、页增删重排、复杂模板、自动渲染审查。用户已有文件另存；插件成果以摘要检查后继续修改。结构验证不等于 PowerPoint/WPS 保真或视觉验收。

0.1.1：表格默认 16pt、按内容估算行高，支持列宽与行高设置，放不下时要求精简或拆页；同文件调用有期限地等待而非立即报争锁；读取与检查只在工作副本运行；发现 Office 占用标记时明确提示关闭文件。不会自动修改已生成的 PPT，也不会清理旧的失败工作目录。

0.1.2：给关闭与删除工作副本预留时间；关闭命令每次最多 4 秒，最多两次尝试，仍受宿主调用期限限制。保留原始操作错误，不让清理错误覆盖它。未确认关闭时保留当前临时副本并报告路径；文件已保存但临时目录删除失败时返回实际成果和清理警告，不冒充文件保存失败。不会扫描或删除之前留下的目录。

0.2.0：进程调用、版本校验和取消处理改为复用应用公共 Office 引擎代码；插件仍保留自己的文件锁、工作副本和成果记录。应用内置 `.docx/.xlsx/.pptx` 上传、解析及只读预览，插件的四个 PPT 工具范围仍限 PPTX。

0.2.1：局部修改在发布前自动核对页面差异，按实际页序返回请求页、变化页及未变化页，并保存到当前成果记录。未请求页面、页数页序、共享资源或其他受保护文件发生变化时拒绝保存，原文件保持不变。比较解压后的内容，忽略 ZIP 压缩差异和 `docProps/core.xml` 核心元数据；核对不证明视觉一致。无法安全识别的文件包会拒绝修改，不绕过检查。

0.2.2：OfficePptPreview 生成指定单页的 HTML 渲染 PNG，通过现有图片结果通道交给支持视觉的模型查看。截图及原文件摘要保存在插件数据目录，原 PPT 保持不变，工作副本照常关闭清理。截图只代表渲染成功，工具不自动标记视觉检查通过；模型实际看图后报告发现，不自动循环修复。需要可用的 HTML 截图浏览器环境；缺失时返回具体错误，不自动安装或改走 PowerPoint。HTML 预览不代表 PowerPoint/WPS 显示完全一致。

0.2.3：OfficePptReview 保存实际看图后的逐页结论与发现，核对源文件 SHA256、截图编号和图片摘要。记录按文件与版本保存，同版本检查页合并，重查某页替换该页发现。OfficePptCheck 仅返回当前版本的 visual_review；旧版本历史保留，但不会作为新版结论。结论范围限 checked_pages，来源明确为模型报告，不将截图成功或部分页通过视为全稿通过。不改 PPT，不增加自动修复循环。

0.2.4：创建前按最终表格行高检查与显式定位文本框的重叠，预留 6pt 间距。冲突时拒绝创建，返回具体页码、表格、文本框及下方文本最小 y；放不下时要求精简或拆页。仅检查明确尺寸的文本框，不检查装饰背景，不自动移动内容，不扫描或修改已有 PPT，仍需截图检查实际排版。

Windows PowerShell 构建：`powershell -ExecutionPolicy Bypass -File plugins/office-work/scripts/build.ps1`。下载固定版本并核对 SHA256，统一输出 `apps/desktop/out/bundled-plugins/office-work.zip`。导入此 ZIP，新建会话选择“演示文稿”。二进制不提交 Git。

测试：先构建准备引擎，再 `node --test plugins/office-work/test/*.test.mjs`。真实引擎测试在临时目录运行，不修改用户材料。

成果在当前工作区；内部当前成果记录在稳定 plugin.dataDir/presentations。仅允许工作区内路径，声明文件读写和 officecli 进程权限。该权限声明不是操作系统沙箱。异常退出遗留 `.office-work.lock` 时，先确认相应操作与引擎已退出，再人工移除对应锁；工具不会自动抢锁覆盖。

设计参考 Orkas 的 PPT 工作流程与 OfficeCLI 适配经验，采用独立实现；相关许可见 THIRD-PARTY-NOTICES.md。
