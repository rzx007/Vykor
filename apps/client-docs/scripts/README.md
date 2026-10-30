# 构建检查

[check-site.mjs](./check-site.mjs) 读取实际生成的 HTML，检查站内页面、文件、锚点和部署前缀，并拒绝混入公开产物的维护 README；直接运行时还检查首页、API 参考、Node service 参考与 Pagefind 搜索资源。只在磁盘读取构建结果，不发送网络请求。

`pnpm --filter @vykor/client-docs build` 在 Astro 完成后自动运行检查；已有产物也可使用 `check:site`。`CLIENT_DOCS_SITE` 与 `CLIENT_DOCS_BASE` 必须与构建时相同。

测试通过包的 `test` 命令执行：

- `__test__/check-site.test.mjs` 使用隔离静态页面验证缺失链接、锚点、Unicode、子路径部署与维护 README 排除。
- `__test__/api-reference.test.mjs` 用真实 TypeDoc 反射与 Markdown 验证公开范围。
- `__test__/site-config.test.mjs` 验证部署前缀规范化及站点 origin 提取，拒绝无效配置。
- `__test__/example-permissions.test.mjs` 导入真实权限示例，在 SDK 请求边界模拟事件与回复，验证重复通知、409 竞争和错误后的清理。

测试只创建自己的临时目录，结束时清理，不连接真实 daemon。

页面状态来自构建产物，测试状态只在本进程。新增检查放在这里，并在 `__test__/` 增加能失败的行为夹具，不用源码文本匹配代替实际生成验证。
