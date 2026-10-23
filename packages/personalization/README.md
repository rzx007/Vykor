# @vykor/personalization

从有来源的用户消息中提取项目环境事实，生成后续会话可以读取的本地规则。它记录服务器、环境、路径等信息，并提供手动替换旧事实的操作。

## 目录与入口

公开入口和实现都在 [`src/index.ts`](src/index.ts)，通过 `@vykor/personalization` 导入。详细流程见 [src 源码说明](src/README.md)，测试在 [`src/__test__`](src/__test__)。

宿主在会话结束时调用 `updateRulesFromSession()`，传入带消息标识、时间和会话标识的用户消息。函数提取事实、过滤疑似凭据、按键合并，保存 `facts.json` 并生成 `rules.md`。读取规则时以有效事实重新生成正文，供 prompts 包加入提示词。

数据保存在配置目录的 `local_rules/projects/<项目名>-<路径摘要>/`，默认配置目录为 `~/.vykor`，可用 `VYKOR_CONFIG_DIR` 重定向。`facts.json` 保存事实、来源和替换关系，`rules.md` 是可重新生成的缓存。

新增事实类型、解析和保存逻辑放 `src/`，测试放同层 `__test__/`。

## 测试

```bash
pnpm --filter @vykor/personalization test
```
