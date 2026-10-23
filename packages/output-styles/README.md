# @vykor/output-styles

加载终端输出样式名称与说明，供终端界面选择渲染方式。

## 目录与入口

公开入口是 [`src/index.ts`](src/index.ts)，通过 `@vykor/output-styles` 导入 `loadOutputStyles()`、`getOutputStylesDir()`、`isKnownOutputStyle()` 和样式类型。文件与扩展位置见 [src 源码说明](src/README.md)，测试在 [`src/__test__`](src/__test__)。

加载时先返回内置 `default`、`minimal`、`codex`，再按文件名顺序读取 `~/.vykor/output_styles/*.md`。文件名作为样式名，正文作为说明；同名用户样式追加到列表中。具体渲染由消费方按名称处理，正文不会注入系统提示词。

样式文件保存在用户目录，每次加载返回新的列表，本包不保存当前选择。新增加载逻辑放在 `src/`，测试放同层 `__test__/`。

## 测试

```bash
pnpm --filter @vykor/output-styles test
```
