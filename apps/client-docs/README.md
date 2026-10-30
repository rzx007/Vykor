# Vykor Client SDK 文档站

面向 `@rzx/client` 使用者的独立静态站点。中文指南介绍调用流程，TypeDoc 从实际发布声明生成 API 参考，示例代码与页面展示共用同一份源码。

## 运行入口

推荐使用 Node.js 24 和根目录指定的 pnpm。文档工具要求 Node.js >= 22.23.4；SDK 使用者的 Node.js 要求仍以 SDK 包声明为准。

在仓库根目录运行：

```sh
pnpm install
pnpm docs:dev
pnpm docs:check
pnpm docs:build
```

`docs:dev` 先构建 SDK，再启动 Astro；访问命令输出的本机地址。`docs:check` 检查站点、两种运行环境的示例与构建检查脚本。`docs:build` 按工作区依赖顺序构建 SDK 和文档，结果位于本目录的 `dist/`；它也检查输出页面、搜索索引和站内链接。

仅安装文档及其依赖、无需执行其他应用的安装脚本时，可运行：

```sh
pnpm --filter @vykor/client-docs... install --frozen-lockfile --ignore-scripts
pnpm docs:build
```

SDK 已构建时可以分别使用 `pnpm --filter @vykor/client-docs dev`、`check-types`、`test` 和 `build`。SDK 导出变化后，重新运行根命令更新声明。包内构建不重复清空 SDK 产物，避免与工作区其他应用的构建互相干扰。

## 目录导航

| 位置 | 职责 |
| --- | --- |
| [astro.config.ts](./astro.config.ts) | 站点名称、中文导航、主题和 API 插件 |
| [config/](./config/README.md) | 部署前缀、站点 origin、TypeDoc 入口与公开范围 |
| [src/](./src/README.md) | 手写内容、内容集合规则与主题 |
| [examples/](./examples/README.md) | 可运行 Node 示例和浏览器集成示例 |
| [scripts/](./scripts/README.md) | 构建产物、链接与部署配置检查 |
| [public/](./public/README.md) | 随站点发布的图标等静态资源 |

## 内容与 API 的来源

指南放在 `src/content/docs/`，页面通过 Starlight `Code` 组件展示 `examples/` 中的同一份源码。README 只介绍仓库维护，不进入公开内容集合；构建结束时也移除静态资源中复制的维护 README，产物检查会拒绝残留 README。

TypeDoc 仅处理 `packages/client/dist/index.d.ts` 与 `packages/client/dist/service.d.ts`，生成 `src/content/docs/api/`。生成目录和 Astro 缓存不提交，不能手写内容。构建前先生成 SDK 声明，保证参考页与实际导出一致；只有公开入口可达的类型进入站点，不读取内部应用包或整个服务端。

构建、类型检查和测试不会连接 daemon、读取真实 token 或运行 Agent。运行示例前的环境要求见 examples 说明；示例中的地址、模型与工作目录由使用者提供。

## 部署

站点输出可放在任意静态服务中。`CLIENT_DOCS_SITE` 提供公开 URL（只取 origin），`CLIENT_DOCS_BASE` 提供相对站点根路径的部署前缀，默认 `/`。例如 PowerShell：

```powershell
$env:CLIENT_DOCS_SITE = "https://rzx007.github.io/Vykor"
$env:CLIENT_DOCS_BASE = "/Vykor/client-sdk/"
pnpm docs:build
```

现有 [Pages workflow](../../.github/workflows/pages.yml) 同时构建官网和文档，将文档复制到官网产物的 `client-sdk/`。仓库 Pages 设置决定公开域名与项目根路径；workflow 从 Pages 输出读取这些值，不写死域名。首页继续使用原官网产物，文档没有第二个互相覆盖的发布流程。本轮只配置流程，远端发布由推送主分支或手动运行触发。

## 新增内容与状态归属

新增指南放在合适的内容分类，更新侧栏；新增示例先补类型检查，再由页面直接引用。对外方法从 SDK 入口生成，不能手动在参考页添加内部接口。链接检查的行为测试位于 scripts 的 `__test__/`。

文档站只保存内容和构建产物，不维护 Agent、会话、权限或连接状态。站点原型沿用 Starlight 官方主题；样式由用户查看后再调整。
