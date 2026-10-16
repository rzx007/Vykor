# 内置 Office 引擎

应用通过 readOfficeBytes/readOfficeFile 解析现代 Office 文件；不需要安装插件。原件仅用于读取字节，OfficeCLI 始终操作独立临时副本，结束后关闭并清理。缓存以原件 SHA256 区分，文件改变后不会复用旧预览。

仅支持 docx/xlsx/pptx，原件上限 64 MB；ZIP 目录拒绝宏、加密和过大解压体积。文字按 Read 的行范围返回；HTML 上限 8 MB。PPT 按页、Excel 按工作表切换，Word 整篇连续展示。HTML 属近似排版，桌面使用禁止脚本和联网的 iframe，只读展示。

开发准备：node scripts/prepare-office-engine.mjs apps/desktop/out/office-engine。桌面构建自动准备固定版本与校验值的二进制及许可证，安装包放在 resources/office-engine。其他进程可设置 VYKOR_OFFICECLI_PATH 指定同版本引擎。

office-work 的 build.ps1 将本目录的 office-engine.mjs 复制进插件 ZIP，复用同一份进程调用实现；插件仍独立携带二进制，并自行负责修改策略、争锁及成果记录。agent-runtime 无 Office 专用逻辑。
