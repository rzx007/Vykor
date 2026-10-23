# @vykor/channels

负责把外部渠道消息交给运行时，并把运行时回复发回原渠道。也提供进程内的事件发布与订阅。

## 功能

- `EventBus` 提供按事件名发布与订阅。
- `MessageBus` 保存入站、出站消息队列。
- `ChannelManager` 统一处理渠道启停、发送者白名单和回复路由。
- `FeishuAdapter`、`HttpAdapter`、`StdioAdapter` 对接具体传输方式。

## 目录与入口

公开入口是 [`src/index.ts`](src/index.ts)，通过 `@vykor/channels` 导入。

| 目录 | 用途 |
| --- | --- |
| [src](src/README.md) | 消息约定、公开导出和源码导航 |
| [src/bus](src/bus/README.md) | 事件订阅、消息队列和白名单判断 |
| [src/core](src/core/README.md) | 管理适配器启停和消息路由 |
| [src/adapters](src/adapters/README.md) | 飞书、HTTP、标准输入输出适配器 |

宿主创建队列和适配器，再启动 `ChannelManager`。适配器收到的消息通过白名单检查后进入入站队列，宿主消费后生成回复，管理器从出站队列取出回复并交给对应适配器。队列、订阅和连接状态都保存在各实例内存中，配置与会话持久化由宿主负责。

新增代码按传输、队列或管理职责放入对应分类，测试放在被测分类的同层 `__test__/`。包入口的检查放在 [`src/__test__`](src/__test__)。

## 使用

```ts
import { EventBus } from "@vykor/channels";

const bus = new EventBus();
bus.on("message", (data) => console.log(data));
bus.emit("message", { text: "hello" });
```

## 测试

```bash
pnpm --filter @vykor/channels test
```
