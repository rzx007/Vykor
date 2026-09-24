# 远程连接

> 状态：当前 daemon 本机发现与远程连接说明。

Task 12 定义两种彼此隔离的连接模式。

- **本机发现：** `vk` 与 `vk --tui` 使用 `~/.vykor/daemon/` 下的私有 daemon registry。该文件含 bearer token，不能复制到其它机器。
- **远程连接：** Web、Desktop 或另一台机器通过安全渠道获得明确的 daemon URL 与 bearer token；它们绝不读取本机 registry。

## 启动可供浏览器连接的 daemon

默认 daemon 绑定 `127.0.0.1`。绑定到非 loopback 地址时必须显式提供 token。浏览器 origin 默认拒绝，必须逐条精确列出。

```bash
vk serve --host 0.0.0.0 --port 8787 \
  --token "$VYKOR_DAEMON_TOKEN" \
  --allow-origin https://desk.example \
  --allow-origin http://localhost:5173
```

非 loopback daemon 前应部署 TLS 与网络访问策略。不要把 token 放进 URL、query string、不受信任页面可读取的浏览器本地存储，或复制出来的本机 registry 文件。

## 连接 TUI

```bash
vk --tui \
  --daemon-url https://daemon.example \
  --daemon-token "$VYKOR_DAEMON_TOKEN"
```

无界面 print 入口使用同一份连接描述，不会因为带了 prompt 就改为启动本机 daemon：

```bash
vk -p "summarize the current session" \
  --daemon-url https://daemon.example \
  --daemon-token "$VYKOR_DAEMON_TOKEN"
```

`--daemon-url` 不会启动或替换本机 daemon，只会把明确的连接描述传入正常的 TUI 或 print 客户端路径。

## Web/Desktop SDK

`@vykor/client` 对普通 HTTP 与 SSE 都使用 `fetch`，因此 bearer token 通过 `Authorization` header 发送，不会出现在事件流 URL 中。

```ts
import { VykorClient, syncEvents } from "@vykor/client";

const client = new VykorClient({
  baseUrl: "https://daemon.example",
  token: process.env.VYKOR_DAEMON_TOKEN,
});

await client.protocol.health();
const sessions = await client.sessions.list();
const state = await syncEvents(client);
```

允许的浏览器 origin 只控制哪些页面能发起跨域请求，并不能替代认证：每个远程请求仍必须携带 bearer token。
