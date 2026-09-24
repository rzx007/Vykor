# 归档：Output Styles（输出样式）

> 状态：历史设计记录。本文以旧 TUI host 的 state/LegacyJSON 接线为前提，不能作为 daemon TUI 的实现依据；当前客户端会话同步见 [client-sync-flow.md](./client-sync-flow.md)。

## 语义(对照 Python 原版确认)

输出样式 = **REPL 渲染模式**,由样式 **name** 驱动渲染分支,**不是** system prompt 注入,
也不是文本后处理 `format` 函数。

- Python `OutputRenderer`(`src/vykor/ui/output.py`)按 `style_name` 分支:
  - `default`:富文本(markdown 重渲染、`⏺`/`⏵` 图标、spinner、panel、status line)
  - `minimal`:极简纯文本(`a>` 提示符、`> tool summary`、`    output`、无 markdown/spinner/panel)
  - `codex`:loader 列出,但**无独立渲染分支** → 渲染同 default(只 `minimal` 被特判)
- Python TUI(`backend_host`)只**列出**样式(带 `active` 标记,供选择器)+ 在 state 里带
  `output_style`,**不**做 render 分支。
- `/output-style` 命令:show / list / set,写 `settings.output_style` 并持久化。

本次为**忠实复刻**:REPL 渲染按 name 分支 + TUI 仅列出/切换。

## 现状(可复用)

- `packages/output-styles/src/index.ts`:骨架,`OutputStyleDefinition { id, name, description, format }`
  + `OutputStyleLoader`(仅内置 default,`format` 原样返回)。**`format` 模型与 Python 不符,重写。**
- `settings.outputStyle?: string`(`packages/core/src/types/settings.ts:58`)已存在,但
  `DEFAULT_SETTINGS`(`packages/core/src/config/settings.ts`)缺默认值。
- REPL `EventRenderer`(`apps/cli/src/renderer.ts`):`RenderOptions { verbose, printMode }`;
  工具开始 `  ○ ${name}(${summary})`,工具结束(verbose)`  ✓/✗ ${line}`。无 markdown/spinner/panel。
- `/output-style` **命令不存在**(仅 `coerceConfigValue` 有 `outputStyle` 分支供 `/config set`)。

## 组件

### a) `packages/output-styles` — 重写 loader(name 驱动)
- `OutputStyleDefinition { name: string; content: string; source: "builtin" | "user" }`
  ——丢掉 `id`/`description`/`format`,对齐 Python `OutputStyle(name, content, source)`。
- `loadOutputStyles(): OutputStyleDefinition[]`:
  - 内置三个:`default`("Standard rich console output.")、`minimal`("Very terse plain-text output.")、
    `codex`("Codex-like compact transcript and tool output.")
  - 用户:`~/.vykor/output_styles/*.md`,stem=name、文件内容=content、source="user",按名排序
- `getOutputStylesDir(): string`:`~/.vykor/output_styles`(递归 mkdir)
- 保留一个轻量 `OutputStyleLoader`?——不必,Python 用自由函数;TS 也用 `loadOutputStyles()` 自由函数。
  (若有消费方依赖旧 `OutputStyleLoader`/`format`,一并改;经检索仅骨架自身,无外部消费方。)

### b) settings 默认值
- `DEFAULT_SETTINGS` 补 `outputStyle: "default"`。

### c) REPL `EventRenderer` 按 name 分支
- `RenderOptions` 加 `outputStyle?: string`(默认 "default")。
- `minimal` 时:
  - 工具开始:`  > ${name} ${summary}`(替代 `  ○ ${name}(${summary})`)
  - 工具结束(verbose):`    ${line}`(纯缩进,替代 `  ✓/✗ ${line}`,含 "... N more lines")
- `default`/`codex`/未知:保持现状(codex==default,与 Python 一致,留 TODO)。
- 加 `setStyle(name: string): void` 供 `/output-style set` 热切换 REPL 实时渲染。
- TS REPL 本就无 markdown 重渲染/spinner/panel,故 Python 的那几个 `minimal` 分支在此无对应物。

### d) `/output-style` 命令(新内置斜杠命令)
- 经 daemon catalog `/output-style` + PATCH `/settings`；纯函数解析见 `slash-helpers.buildOutputStyleResult`。
- 语义对齐 Python `_output_style_handler`:
  - 无参 / `show` → "Output style: <current>"
  - `list` → 每行 `<name> [<source>]`,当前项加 active 标记(如 `* default [builtin]`)
  - `set <NAME>` 或裸 `<NAME>` → 校验 ∈ loadOutputStyles().name;未知 → "Unknown output style: <NAME>";
    合法 → `settings.outputStyle = NAME` + saveSettings + 热更新 REPL renderer(`renderer.setStyle`)
  - 其它 → "Usage: /output-style [show|list|NAME]"
- 当时的 REPL 与旧 TUI host 都可用。
- 抽可测纯函数:`buildOutputStyleResult(args, styles, current)` → `{ message, newStyle? }`,
  把"参数解析 → 结果消息 + 是否切换"与 IO(load/save/renderer)分离,便于单测。

### e) TUI 后端:state 带 output_style
- 后端 emit 的 state payload 里带 `output_style: settings.outputStyle`(对齐 Python protocol),
  让 TUI 知道当前值。**不**做 render 分支(本次范围)。
- (TUI 图形化样式选择器 UI 不在本次范围。)

## 测试

- **loader**:`loadOutputStyles` 含 3 个内置(name/source 正确);写一个临时用户 `.md` 能被加载为
  source="user";排序;`getOutputStylesDir` 路径正确。
- **EventRenderer**:`minimal` 下工具开始/结束行格式与 `default` 不同(捕获 stdout 断言);
  `default`/`codex` 保持原格式;`setStyle` 切换后续渲染。
- **`/output-style`**:`buildOutputStyleResult` 的 show/list/set/裸名/未知/用法分支;
  set 合法时返回 newStyle、未知时不返回;active 标记。

## 范围外

- `codex` 独立渲染(渲染同 default,留 TODO,与 v0.1.9 一致)。
- TUI render 分支、TUI 图形化样式选择器 UI。
- system-prompt 注入(Python 不做)。
- 项目级 `.vykor/output_styles`(最小版只 user 级 `~/.vykor/output_styles`)。

## 与 Python 的已知差异(刻意)

- **`list` 输出**加 `*`/空格 active 标记(Python 是纯 `name [source]`)——便于 REPL 直观看当前项。
- **config 目录**:`getOutputStylesDir()` 默认硬编码 `~/.vykor/output_styles`,不读 `VYKOR_CONFIG_DIR`
  ——与本仓 `settings.ts` 的 IO 一致(整个 TS app 都硬编码 homedir);若将来 settings 接入
  `VYKOR_CONFIG_DIR`,这里一并改以保持 parity。
- **TUI `/output-style set` 当前不持久化**:TUI host 的 `updateSettings` 是 no-op(对**所有**
  设置类命令的既有限制)。~~且 TUI 不 render-branch~~——E.3 收口后 TUI 已有 minimal 工具行分支（详见 tui-render-tail-design.md），热切换经 state_snapshot 即时生效。
