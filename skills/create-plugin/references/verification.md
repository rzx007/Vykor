# 验证与交付

## 分开说明验证到哪一步

1. 文件/语法：manifest 与组件路径存在，Node 入口能通过 `node --check`；构建 UI 成单文件。
2. 静态插件校验：有可用 CLI 时运行 `vk plugin validate <目录>`，检查结构、UI 定义、HTML 路径和大小。它不执行工具或前端。
3. 工具逻辑：用受控输入实际调用纯逻辑工具，检查返回、错误与副作用；不得以 import 成功代替业务验证。
4. 宿主激活：用户授权安装或 link 后，检查 Tool Host、MCP 连接、Hook 与组件诊断。
5. 桌面交互：真实确认、取消、结果更新、内联/侧栏切换、关闭后重开、连续点击、只读和失败状态。

只安装 Desktop 的用户不一定有 `vk`。先检测命令是否存在，不要求为了通过一句检查而安装不明 CLI。没有 CLI 时报告未完成静态宿主校验；用户可在插件页导入并查看详情。没有模型、可运行客户端或授权时，不声称完成对应验收。

纯逻辑工具可用 Node 的 `node:assert/strict` 直接测试 `registerTools()` 返回的 invoke；有外部访问和副作用的工具用隔离输入，不在测试里连接生产服务。真实 Tool Host 的权限、超时与取消仍需宿主验证。

## 安装仅在用户要求时执行

```sh
vk plugin validate ./my-plugin
vk plugin link ./my-plugin --approve ui:render --approve ui:invoke-own-tools
vk plugin list --verbose
vk plugin details example.my-plugin
```

上述批准项只适用于带 UI 的无其他权限插件；其他请求按实际安装预览逐项批准。Skill-only 插件不应照抄 UI 权限。不要绕过权限确认，不自动安装、更新、替换、发布。

link 用于开发，源目录改动后在没有运行任务的会话使用 `/reload-plugins`。它关闭当前 cwd 的旧 Runtime，后续使用重新加载，不是热更新；ID、版本或权限变化要重新 link 并确认。

正式安装用 `vk plugin install-local <目录>`；Desktop 也支持本地 `.zip`、`.tar`、`.tar.gz`、`.tgz` 或 Git URL/ref 导入。安装后的内容是快照，改源目录不会改变已安装版本。重新导入同一 ID 是更新/修复，新权限要确认，通常从下一次对话生效。

## 打包

打包实际插件目录，不要把整个 Skill 分发目录当作 Native Plugin。包里必须只有一个 `.vykor-plugin/plugin.json`，位于根目录或唯一一层包装目录。包含已生成的 HTML 和真实入口，不能依赖接收者安装 node_modules 后才生成文件。

以插件目录名 `my-plugin` 为例，在其父目录执行：

```sh
tar -czf my-plugin.tgz my-plugin
```

使用 ZIP 时确认压缩工具保留 `.vykor-plugin/`；一些工具会跳过隐藏文件。排除 node_modules、凭据、日志、临时测试数据和符号链接；依赖应在作者侧构建到运行文件里。

## 出问题时

| 表现 | 检查 |
| --- | --- |
| 导入失败 | 包内唯一 manifest、路径、大小、快照诊断 |
| 等待生效 | 新建对话；或在无任务时重新加载插件 |
| 缺少权限 | 重新导入并确认新增权限，不修改批准记录 |
| 工具不可用 | entry 路径、Node 语法、运行期 import、local 环境与 Tool Host 详情 |
| 有文字没有 UI | metadata.ui、componentId、UI 授权、客户端/后台能力、数据大小 |
| UI 操作失败 | actionId/tool 对应、真实 inputSchema、readOnly、当前 revision、会话忙状态 |

交付时写明目录、组件、权限、调用入口、已执行的检查和未验证项。发布到哪里、使用哪种许可证、由谁安装由用户决定；不要把未发布 SDK、未完成 GUI 验收或安装成功包装成完整运行验证。
