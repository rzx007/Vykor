# Client 阶段 5B：协议协商实现计划

> **面向 AI 代理的工作者：** 使用 superpowers:executing-plans 批量实现。先写完生产代码，只做类型快检；阶段 5 末统一测试、修复和审查。

**目标：** 将 health、capabilities、协议兼容判断和 IncompatibleProtocolError 提取到 ProtocolClient。

**架构：** ProtocolClient 只接 HttpTransport。它解析 ServerCapabilities 并执行兼容检查，不缓存全局协议状态，也不让业务 Resource 隐式发 capabilities 请求。

**技术栈：** TypeScript、@vykor/protocol、Vitest。

---

## 文件

- 创建 packages/client/src/protocol/protocol-client.ts
- 创建 packages/client/src/protocol/index.ts
- 修改 transport/http-client.ts 与 Client/index.ts
- 最终创建 protocol-client.test.ts

## 批量实现

- [ ] 迁出 health(options) 与 capabilities(options)。
- [ ] 迁出 IncompatibleProtocolError，保持 capabilities/reason/message 字段。
- [ ] ProtocolClient 构造只接 HttpTransport。
- [ ] health 请求继续 auth:false。
- [ ] capabilities 请求继续 auth:false，支持 caller 的 ClientProtocolSupport。
- [ ] 使用 parseServerCapabilities、checkProtocolCompatibility、CURRENT_PROTOCOL_VERSION。
- [ ] incompatible 时抛原错误，不包装 ProtocolDataError。
- [ ] 不新增 capabilities cache、自动 retry 或 Resource 前置握手。
- [ ] VykorClient 暴露 readonly protocol。
- [ ] 旧 health/capabilities 方法转发到 protocol。
- [ ] 公共 export 保持旧路径，同时可导出 ProtocolClient。
- [ ] 快检 Client 类型。
- [ ] 提交：refactor(client): extract protocol negotiation client

## 统一测试清单

- health path/auth/signal；
- capabilities 默认/自定义 support；
- compatible/minor/major/version missing；
- malformed capabilities；
- facade 返回与直接 protocol 调用一致；
- 调用一次业务 Resource 不产生额外 capabilities 请求。

## 审核重点

协议检查只有一处；Resource 不自行握手；没有全局状态；兼容错误完全一致。
