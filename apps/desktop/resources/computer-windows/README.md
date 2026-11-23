# Windows Computer Use 驱动资源

`driver-release.json` 固定上游 Cua 源码提交、Windows x64 压缩包、可执行程序摘要和签名发布者。随安装包提供的 `CUA-LICENSE.txt` 对应该提交的 MIT 许可证。 [上游发布](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.2) · [上游许可](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/LICENSE.md)

开发时可在仓库根目录运行 `node scripts/prepare-cua-driver.mjs` 提前准备驱动。已有压缩包时添加 `--archive` 和压缩包路径。脚本核对压缩包摘要，再提取 MCP 直连使用的 `cua-driver.exe`，核对文件摘要、x64 架构、Authenticode 签名和发布者。文件准备到 `apps/desktop/out/computer-windows/x64/`。

Windows x64 打包把驱动、发布清单和许可证复制到应用的 `resources/computer-windows/`。用 `node apps/desktop/scripts/verify-cua-packaging.mjs --artifact` 加解包产物的 `resources` 路径复核。文件校验期间无需启动驱动。
