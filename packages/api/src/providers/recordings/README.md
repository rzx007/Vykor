# 供应商 HTTP 录制与离线回放

这里保存供应商实际返回的 HTTP SSE 数据。SSE 是服务器按顺序发送多条事件的文本响应；回放仍经过现有客户端和 SDK 的真实解码流程，仅替换发 HTTP 请求的边界。

## 文件与入口

- [http-recording.ts](http-recording.ts)：内存录制、脱敏检查、请求比较和封闭回放；没有默认网络回退或磁盘副作用。
- [capture-probe.ts](capture-probe.ts)：需要手动执行的公开探针，每次只发送一条请求，不属于日常测试入口。
- [__test__/](__test__/README.md)：录制设施的构造数据和探针初始化安全测试。
- [__test__/fixtures/](__test__/fixtures/README.md)：真实供应商样本、来源说明和清单。
- [集成回放测试](../../../../../../tests/agent-integration/provider-recording-replay.integration.test.ts)：真实 OpenAI SDK 与 Codex HTTP 解码器的回放。

## 运行流程与状态

调用方把实际 fetch、请求和需删除的私人字符串交给 `captureHttpExchange`。函数读取响应，默认最多保留 256 KiB（可用 maxResponseBytes 收紧）；超限会取消剩余响应并报错。函数删除请求地址的主机和所有请求头，只保留响应的 content-type / retry-after，然后替换已知秘密及其 JSON 转义形式。脱敏先合并网络分块，因此秘密横跨网络分块也不会遗漏；原始 SSE 事件顺序、事件间的工具参数碎片、stop 和 usage 不变。未脱敏内容只在本次调用内存中存在。

`createHttpReplay` 复制录制数据并维护独立消费位置。每次请求比较方法、路径和 JSON 请求体，JSON 对象键顺序不影响比较；失败不消耗样本。额外请求、未消费样本和缺失的 required 真实样本都会报错。返回的 Response 由现有解码器读取，不使用外网或真实密钥。当前客户端只实现 HTTP SSE，没有 WebSocket 回放覆盖。

录制仅凭内容无法自动证明来源。`source.kind=observed` 必须来自一次真实边界观测，不能手写构造事件后改标签。清单中的 SHA-256 用来检测样本意外改动，不能作为供应商真实性证明。真实样本通过仓库 `.gitattributes` 按原始字节保存，避免 Windows 检出时的换行转换导致清单校验失败。构造测试明确使用 synthetic。

## 脱敏与采集约束

采集只提交固定公开提示，不读取私人对话。请求头、Cookie、主机不会写入录制；调用方仍必须显式提供凭据、自定义头和私人文本作为 redactions。内置检查拒绝常见密钥、JWT、个人目录、敏感字段，包括未知事件内和跨分块的字段。检查按 SSE 帧合并 data 行，支持 event 名称、注释前缀和 CRLF 换行，再递归检查完整 JSON；普通 JSON 和工具参数字符串的前导空白不会跳过检查。扫描只检查内容，不改写未知事件结构。它无法识别任意私人自然语言；采集者必须审查提示与响应，再保存样本。遇到未知秘密或 encrypted_content，检查会失败，不落盘。

当前探针仅支持配置中的 tokenharbor / mimo-v2.5:free（128 输出 token 上限）和已有 Codex 登录（实际客户端短文本请求，45 秒 / 64 KiB 预算）。Codex 客户端目前不发送输出 token 上限，不能声称硬限制 128。模型名中的 free 是配置标签，计费未独立验证。脚本不自动重试、不续轮，不修改用户设置或登录文件。

路由校验、设置和凭据读取、JSON 解析、客户端构造都在同一个错误保护范围内；初始化或请求失败时仅输出路由、失败标记和错误类型，不打印可能包含凭据原文的错误消息或堆栈。初始化回归测试用合成文件内容替换读取，并阻止 fetch，不接触真实凭据或供应商。

从仓库根目录执行离线验证：

```powershell
node node_modules/vitest/vitest.mjs run --root packages/api src/providers/recordings/__test__/http-recording.test.ts src/providers/recordings/__test__/capture-probe.test.ts
node node_modules/vitest/vitest.mjs run --config tests/agent-integration/vitest.config.ts tests/agent-integration/provider-recording-replay.integration.test.ts
```

只有获准新增实际观测时才运行采集脚本；它会覆盖对应 route 的样本，之后需要人工审查并更新清单摘要：

```powershell
node --import ./apps/cli/node_modules/tsx/dist/loader.mjs packages/api/src/providers/recordings/capture-probe.ts openai
node --import ./apps/cli/node_modules/tsx/dist/loader.mjs packages/api/src/providers/recordings/capture-probe.ts codex
```

新增录制或检查放本分类，不扩展客户端的运行时职责。只有供应商实际支持的传输方式才加入真实覆盖清单。
