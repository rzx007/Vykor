# Windows Computer Use 驱动资源

`driver-release.json` 固定上游 Cua 源码提交、Windows x64 压缩包、可执行程序摘要和签名发布者。随安装包提供的 `CUA-LICENSE.txt` 对应该提交的 MIT 许可证。 [上游发布](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.2) · [上游许可](https://github.com/trycua/cua/blob/fc188250b4ca8549b8e61f937fdb1fb560770e86/LICENSE.md)

在 Windows x64 上从源码启动 Desktop 时，`pnpm --filter @vykor/desktop dev` 和 `start` 会自动检查驱动。驱动准备流程在 Desktop 包目录下生成 `out/computer-windows/x64/`。首次启动或驱动与固定版本不符时，启动流程自动下载并核验。成功后直接启动 Desktop，本地驱动有效时复用。准备失败会在终端提示，Desktop 仍可启动。

用于打包或离线准备时，可在仓库根目录运行 `node scripts/prepare-cua-driver.mjs`。已有压缩包时添加 `--archive` 和压缩包路径。脚本核对压缩包摘要，再提取 `cua-driver.exe`，核对文件摘要、x64 架构、Authenticode 签名和发布者。

Windows x64 打包把驱动、发布清单和许可证复制到应用的 `resources/computer-windows/`。用 `node apps/desktop/scripts/verify-cua-packaging.mjs --artifact` 加解包产物的 `resources` 路径复核。文件校验期间无需启动驱动。
