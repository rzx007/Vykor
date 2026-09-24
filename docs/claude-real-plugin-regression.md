# Claude Code 真实插件回归

> 状态：当前手动回归套件。

这套回归用真实 Claude Code 插件源码验证完整链路：

```text
Claude Code plugin source
  -> detect
  -> inspect
  -> plan
  -> convert
  -> Native validate
  -> installLocalNativePlugin
  -> Runtime discover
```

它不是普通 CI 默认测试，因为它依赖外部 GitHub 源码。目标是定期抽样真实生态输入，确认 Converter 和 Runtime 的边界仍然保守、可诊断、不误执行。

## 样本来源

当前样本来自 Anthropic 官方 Claude Code 插件目录：

- Repository: `https://github.com/anthropics/claude-plugins-official`
- 固定 commit: `b819188d2eea14e0400556ca29dbd1179a7c595b`
- 本次回归日期：2026-08-26

下载方式示例：

```powershell
$root = Join-Path $env:TEMP 'vk-real-plugins'
New-Item -ItemType Directory -Force -Path $root | Out-Null
git clone --depth 1 --filter=blob:none --sparse https://github.com/anthropics/claude-plugins-official.git (Join-Path $root 'claude-plugins-official')
Set-Location (Join-Path $root 'claude-plugins-official')
git sparse-checkout set .claude-plugin plugins external_plugins
git rev-parse HEAD
```

如果 HEAD 不是上面的固定 commit，应先记录新的 commit，再重新审查样本结果。

## 复跑命令

```powershell
pnpm exec tsx scripts/claude-real-plugin-regression.mjs `
  --cwd D:\code\personal-project\Vykor `
  $env:TEMP\vk-real-plugins\claude-plugins-official\plugins\frontend-design `
  $env:TEMP\vk-real-plugins\claude-plugins-official\plugins\commit-commands `
  $env:TEMP\vk-real-plugins\claude-plugins-official\plugins\plugin-dev `
  $env:TEMP\vk-real-plugins\claude-plugins-official\plugins\example-plugin `
  $env:TEMP\vk-real-plugins\claude-plugins-official\plugins\claude-security `
  $env:TEMP\vk-real-plugins\claude-plugins-official\plugins\ralph-loop `
  $env:TEMP\vk-real-plugins\claude-plugins-official\plugins\explanatory-output-style `
  $env:TEMP\vk-real-plugins\claude-plugins-official\plugins\hookify
```

脚本只把转换产物、cache 和 installed store 写到系统临时目录。默认结束后删除临时目录；需要保留现场时设置：

```powershell
$env:VYKOR_KEEP_REAL_PLUGIN_REGRESSION = '1'
```

## 当前样本结果

| 样本 | 覆盖点 | 结果 | 关键观察 |
| --- | --- | --- | --- |
| `frontend-design` | skill-only | passed | 1 个 skill exact 转换，Runtime discover 无 warning。 |
| `commit-commands` | commands | passed | 3 个 command adapted 为 Native skills。 |
| `plugin-dev` | skills + commands + agents | passed | 7 个 skill exact，1 个 command adapted，3 个 agent adapted。 |
| `example-plugin` | skills + command + MCP | passed | 2 个 skill exact，command adapted，`.mcp.json` adapted 为 Native MCP。 |
| `claude-security` | skills + agents + unsupported hook | passed / partial | `UserPromptExpansion` 没有 Native v1 等价事件，报告为 unsupported，没有生成误导性 hook。 |
| `ralph-loop` | commands + unsupported hook | passed / partial | `Stop` 没有 Native v1 等价事件，报告为 unsupported，只生成 command skills。 |
| `explanatory-output-style` | supported hook | passed | hook 文件 adapted 为 Native hooks。 |
| `hookify` | skills + commands + agents + mixed hooks | passed / partial | `PreToolUse` / `PostToolUse` adapted；`Stop` / `UserPromptSubmit` unsupported。 |

所有样本都完成了 `convert -> validate -> install -> Runtime discover`。本轮没有样本生成 Native Tool；这是预期行为。Claude Code 的普通命令、hook 脚本和辅助脚本不能被自动升级成 Vykor Native Tool。

## 本轮修复

真实样本暴露了一个诊断问题：只有 unsupported hook 事件的插件，plan 里仍会把整个 hook 文件标成 `adapted`，但最终不会生成 Native hooks。

已修复为：

- hook 文件只有存在至少一个可映射事件时，才生成 `hooks:<path>` 的 `adapted` plan item；
- unsupported 事件继续逐项输出 `hooks:event:<event>`；
- 已增加单元测试锁住 unsupported-only hook 行为。

## 验收原则

- 真实插件源码只读；转换、inspect、plan 不执行脚本、不启动 MCP、不安装依赖。
- `unsupported` 是正常结果，不是失败；不能为了提高成功率而扩大 Runtime 语义。
- 如果转换产物没有 Native Tool，Runtime discovery 里也不能出现 tool activation。
- 如果未来真实样本开始生成 Native Tool，必须额外验证调用审计、inputSchema 校验、权限批准、超时、取消、并发和输出限制。
