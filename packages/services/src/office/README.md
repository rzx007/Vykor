# 内置 Office 引擎

应用通过 readOfficeBytes/readOfficeFile 解析现代 Office 文件；不需要安装插件。原件仅用于读取字节，OfficeCLI 始终操作独立临时副本，结束后关闭并清理。缓存以原件 SHA256 区分，文件改变后不会复用旧预览。

仅支持 docx/xlsx/pptx，原件上限 64 MB；ZIP 目录拒绝宏、加密和过大解压体积。文字按 Read 的行范围返回；HTML 上限 8 MB。PPT 按页、Excel 按工作表切换，Word 整篇连续展示。HTML 属近似排版，桌面使用禁止脚本和联网的 iframe，只读展示。

开发准备：node scripts/prepare-office-engine.mjs apps/desktop/out/office-engine。桌面构建自动准备固定版本与校验值的二进制及许可证，安装包放在 resources/office-engine。其他进程可设置 VYKOR_OFFICECLI_PATH 指定同版本引擎。

office-work 的 build.ps1 将本目录的 office-engine.mjs 复制进插件 ZIP，复用同一份进程调用实现；插件仍独立携带二进制，并自行负责修改策略、争锁及成果记录。agent-runtime 无 Office 专用逻辑。

Word 文字提取使用段落查询，包含表格中的段落并保留行、列路径。引擎输出超过上限或被截断时明确报错，不将部分内容当成完整结果。

交付检查：`node apps/desktop/scripts/verify-office-packaging.mjs`。安装包解压后用 `--artifact <resources目录>` 核对实际资源和主程序；设置 `ELECTRON_RUN_AS_NODE=1`，用解包应用可执行文件运行同一脚本并加 `--smoke`，验证运行进程可自动定位引擎及读取 Word 表格。只生成临时测试文件，不启动界面。

## 入口与流程

`readOfficeBytes()` 或 `readOfficeFile()` 校验格式与大小，再通过 Office 引擎读取临时副本；文字辅助函数检查输出完整性。

## 状态归属

原件由调用方持有，缓存按内容校验值区分；引擎操作独立临时副本并在结束时清理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [contracts.ts](./contracts.ts) | `OfficeDocumentPreview` |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [office-documents.ts](./office-documents.ts) | `MAX_OFFICE_BYTES`、`readOfficeBytes`、`readOfficeFile` |
| [office-engine.d.mts](./office-engine.d.mts) | Office 引擎的 TypeScript 类型声明 |
| [office-engine.mjs](./office-engine.mjs) | `OFFICE_VERSION`、`OFFICE_ASSETS`、`hash` 等 |
| [office-text.ts](./office-text.ts) | `wordParagraphText`、`assertCompleteOfficeText` |

## 测试与维护

Office 读取、引擎接入和输出转换放在这里，具体界面预览由桌面端负责。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
