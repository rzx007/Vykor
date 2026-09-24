# @vykor/channels

EventBus 渠道系统，用于事件发布/订阅。

## 功能

- 发布/订阅模式
- 事件通道管理

## 使用

```ts
import { EventBus } from "@vykor/channels";

const bus = new EventBus();
bus.subscribe("message", (data) => console.log(data));
bus.publish("message", { text: "hello" });
```

## 测试

```bash
pnpm --filter @vykor/channels test
```