# 私有应用客户端

`@vykor/application-client` 为 Desktop、TUI 与 CLI 提供产品业务接口。包设置 `private: true`，通过源码入口参与工作区构建，不单独发布。

调用方创建 `new VykorClient({ baseUrl, token, fetch })`。构造只组装资源，首次请求通过公开 SDK 的 HTTP 连接检查协议并发送请求；服务端保存业务数据。会话事件同步和恢复直接使用 `@rzx/client`，本包不维护第二套状态。

## 目录导航

- [src/](./src/README.md)：产品客户端及统一导出。
- [commands/](./src/commands/README.md)：斜杠命令及展示结果。
- [resources/](./src/resources/README.md)：业务请求、产品会话与附件维护。
- [types/](./src/types/README.md)：业务参数与响应类型。

新业务接口放在对应 resources 分类；命令放 commands；会话生命周期、事件同步、连接逻辑放公开 SDK。

## 检查

运行 `pnpm --filter @vykor/application-client check-types`、`pnpm --filter @vykor/application-client test`。本包直接导出 TypeScript 源码，`build` 验证源码类型，产品打包器负责最终产物。
