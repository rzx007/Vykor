# Desktop 与 CLI Tag 发版

> 状态：当前实现。稳定版 GitHub tag 同时发布 Desktop 安装包和 npm CLI；tag 只会在检查和安装包构建全部通过后创建。

## 一句话结论

在 GitHub Actions 页面手动触发 Tag Release 工作流并输入版本号。工作流先固定触发时的完整 commit，在这个 commit 上完成检查和打包，成功后才创建 tag；接着发布 `@rzx/ohs`，npm 在线校验通过后才创建或更新 GitHub Release。最后会回读 Release notes 和资产列表。已安装的 Desktop 会在启动后静默检查这个 Latest Release；发现新版本后自动下载，标题栏胶囊提示进度，下载完成后可立即重启安装，或等退出时自动安装。

## 发什么

| 产物 | 用户怎么拿到 |
|------|----------------|
| Windows `Vykor-X.Y.Z-setup.exe` | GitHub Release Latest，支持应用内更新 |
| Linux `Vykor-X.Y.Z.AppImage` | GitHub Release Latest，支持应用内更新 |
| Linux `Vykor-X.Y.Z.deb` | GitHub Release Latest，手动安装，不走应用内更新 |
| `@rzx/ohs@X.Y.Z` | `npm install -g @rzx/ohs` |

macOS 安装包本轮不发布。Windows 当前不签名，首次安装可能被 SmartScreen 拦截。

## 版本规则

- 唯一版本源是稳定 tag：`v1.0.1`、`v1.2.0`。预发布 tag（例如 `v1.0.1-beta.1`）不会触发这条流水线。
- GitHub Release 和 npm 必须是同一个 `X.Y.Z`。
- Desktop 现在是 `1.0.0`。低于 `1.0.0` 的版本不会被已安装客户端识别为更新，所以统一发版的第一枪是 **`v1.0.1`**。
- CI 只在 runner 上改根目录 `package.json`、`apps/desktop/package.json` 和 `apps/cli/package.json`，不回写 Git。仓库里的这三个版本可以暂时落后于即将发布的 tag。本机若要打安装包并对齐版本号，可临时运行 `node scripts/prepare-tag-release.mjs v1.0.1`，不要提交。
- `@rzx/ohs` 由这条 tag 流水线发布。Changesets 继续只管可发布的 `@vykor/*` 包，不再包含 CLI。

## 发版前检查

1. `main` 上的 CI 已经通过。
2. npm 包 `@rzx/ohs` 已配置 Trusted Publisher：GitHub 用户 `rzx007`、仓库 `vykor`、工作流文件名 `tag-release.yml`（允许 `npm publish`）。不再依赖仓库 Secret `NPM_TOKEN`。
3. 工作流权限能写 `contents`（创建 Release）和 `id-token`（npm Trusted Publishing / provenance）。
4. 本地确认 tag 格式和打包配置：

```bash
pnpm test:scripts
pnpm --filter @vykor/desktop verify:update-packaging
```

## 正式发版

在 GitHub 仓库页面手动触发：

1. 进入 **Actions** → **Tag Release** 工作流。
2. 点击 **Run workflow**，在 `version` 输入框填写版本号（例如 `1.0.1`）。
3. 点击确认。

工作流按以下顺序执行：

1. 固定触发时的完整 commit，校验版本格式，以及已有同名 tag 是否指向该 commit。
2. 在临时工作树同步候选版本，运行类型检查、全量测试、架构边界检查、文档检查和脚本测试，并生成固定的 release notes。
3. 在 Windows / Ubuntu runner 构建 Desktop；每个平台都会直接读取已打包的 `app.asar`，记录其中 migration 文件及 SHA-256，再上传安装包、更新清单和 inventory。
4. 汇总任务确认 Windows / Linux 安装包都包含基线与全部增量迁移（journal 与文件一一对应），并且文件内容一致。只有前述检查全部成功，才创建并推送 `vX.Y.Z` tag。已有 tag 指向同一 commit 时复用；指向其他 commit 时直接失败。
5. 构建并发布 `@rzx/ohs`。已存在的精确版本会跳过上传，但仍通过 `npm view @rzx/ohs@X.Y.Z` 在线确认。
6. 只有 npm 发布及在线确认成功，才创建或更新 GitHub Release。重跑会同时覆盖资产和 notes，避免页面说明与证据不一致。
7. 再次读取 npm、GitHub Release notes 和资产列表，核对无误后把版本、tag 与完整 commit 写进 job summary。

## 客户端怎样更新

打包后的 Windows 和 Linux AppImage 启动后会延迟几秒后台检查 GitHub Latest Release。

- 没有新版本，或检查失败：不打扰用户，只写日志。
- 发现新版本：后台自动下载，标题栏胶囊显示进度。
- 下载完成：胶囊变成「重启安装」；用户也可以直接退出，退出时自动安装。
- 立即安装会先走 Desktop 的强制退出逻辑，避免主窗口被藏到托盘后装不上。

开发模式和 macOS 不检查更新。`apps/desktop/dev-app-update.yml` 只给显式开发测试用。

## 失败重跑和回滚

- 同一 tag 指向同一 commit 时可以重新跑 workflow。Desktop 资产和 release notes 会覆盖；npm 上已有的精确版本会被跳过，但仍进行在线校验。
- 类型检查、测试或 Desktop 构建失败时，远端不会出现 tag。npm 发布或在线校验失败时，不会创建可登记的 GitHub Release。
- 同名 tag 已指向其他 commit 时，不会移动 tag；请改用更高的新版本。
- 不要改已经发布的 npm 版本内容。修 bug 请打下一个 patch tag，例如 `v1.0.2`。
- 如果 GitHub Release 有问题，可以删掉该 Release 后重跑，或再发一个更高版本。已经装上错误版本的用户，需要再收到一个更高版本才会更新。

## 应急手动发布 CLI

正式路径是 tag Action。只有 CI 不可用时才在仓库根目录手动：

```bash
pnpm release:cli:dry -- 1.0.1
pnpm release:cli -- 1.0.1
```

必须写成与 GitHub tag 相同的 `x.y.z`，不能省略版本，也不能用 patch / minor / auto。
