# @vykor/plugins

Vykor Native Plugin 的校验、组件加载、安装状态、版本 cache 与激活基础设施。

Runtime 只接受插件根目录中的 `.vykor-plugin/plugin.json`。Claude Code、Codex 等外部格式不在本包解析，必须先由 `@vykor/plugin-converters` 转为 Native Plugin。

当前 manifest 是严格的 Native v1 schema，只接受当前字段。安装 scope 只有 `user` 与 `managed`：用户可以管理 `user` 插件；`managed` 插件不可由普通安装、覆盖或卸载流程修改。旧记录和旧 manifest 字段不会被读取或转换。

当前 Native v1 可加载 Skills、Agents、Hooks、MCP 和 Node Tool。Tool 模块只会在独立子进程中加载；插件元数据加载阶段不会 import 第三方代码。Wasm Tool 目前只校验和提示，不会激活。

Node Tool 入口必须导出 `registerTools(context)`，并返回 Tool 定义数组。每个定义包含 `name`、`description`、`inputSchema` 和 `invoke(input, context)`；`invoke` 返回标准的 `{ content: [...] }` Tool 结果。一个插件版本共用一个 Tool Host 子进程，Agent Runtime 关闭或 Host 崩溃时会注销该插件注册的全部 Tool。

Agent Runtime 会在进入插件代码前做调用控制：按 `inputSchema` 校验输入、记录每次调用的审计摘要、限制同一插件版本的并发调用数，并对 stdout、stderr 和插件日志做大小限制。权限批准缺失的 installed record 不会被激活，需要重新批准权限或重装插件。

当前子进程边界可以隔离崩溃和 daemon 的环境变量，但还不是操作系统级沙箱。第三方 Node 代码仍可直接调用 Node 文件、网络和进程 API；不要把 manifest 权限误解为完整的系统调用拦截。

## 关闭插件功能

持久关闭所有已安装插件贡献：

```bash
vk config set plugins.enabled false
```

重新开启：

```bash
vk config set plugins.enabled true
```

只关闭本次新建 Session 的插件贡献，可以使用 `vk --no-plugins`。总开关只跳过 installed Native Plugin，不影响内置 Skill、普通用户/项目 Skill、Settings Hooks 或 Settings MCP。单插件仍使用 `vk plugin enable/disable <id>` 管理。

```bash
pnpm --filter @vykor/plugins test
pnpm --filter @vykor/plugins check-types
```
