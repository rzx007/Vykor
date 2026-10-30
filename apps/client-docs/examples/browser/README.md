# 浏览器示例

`connect.ts` 导出 `connect(options, signal?)`，由网页应用调用。它检查 daemon 的通信协议与能力，读取已有会话后返回客户端和结果。连接参数由应用传入，不读取 Node 环境变量。

会话和运行记录属于 daemon；网页保存连接和展示状态。daemon 需允许网页的准确来源，token 由应用在运行时管理。参数说明与检查命令见[示例总览](../README.md)。

新的浏览器示例放在本目录，只从 `@rzx/client` 主入口导入。`tsconfig.json` 不加载 Node 全局类型，用来发现误用 `process` 等浏览器不可用接口；不要导入 `@rzx/client/service`。
