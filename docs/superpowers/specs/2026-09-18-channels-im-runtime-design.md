# 通道扩展设计：从 Feishu 走向通用 IM runtime

## 1. 背景与目标

当前通道层已经具备最基础的抽象：ChannelAdapter、ChannelMessage、ChannelManager 能处理“消息进入 / 消息发出”这条主链路，但它仍停留在“可调用的最小骨架”层级。

真实 IM 场景需要更多语义：

- 识别私聊 / 群聊 / topic / thread
- 跟踪 sender、chatId、replyTo、conversationKey
- 过滤 bot 自己消息、@ 机器人消息、白名单消息
- 支持文本、图片、文件、卡片、流式过程输出
- 区分 delivery 结果：sent / failed / unknown
- 在跨平台时保持上层业务的一致接口

因此本次需求的目标不是“再补一个飞书函数”，而是把 channels 设计成一层真实的 IM runtime 抽象，并以 Feishu 作为第一条验证适配器。

## 2. 审查修订意见

本设计在初版中已覆盖主要方向，但在子代理审核中发现两处需要收紧：

1. 范围需更明确：本设计应聚焦在通道抽象层，而不是平台业务层。未来的 stream / card / file delivery 可以是 adapter 的实现细节，不应在通用层被过度承诺。
2. 术语需更严谨：`conversationKey`、`conversationId`、`chatId`、`replyTo` 的关系需要明确定义；否则会和现有 `ChannelManager` 的路由语义冲突。
3. 能力声明应为可选 metadata，而非强制所有 adapter 在 v1 中都实现全能力集。
4. 设计应明确阶段边界：第一阶段聚焦文本 + 路由 + delivery 状态，第二阶段再补多媒体与流式能力。

以下修订已纳入本文档。

## 3. 当前问题

现有设计的主要问题包括：

1. Message 语义过轻
   - 只有 id、channel、sender、content、timestamp、replyTo、metadata。
   - 缺少 conversation/thread/workspace/attachment/message-type 等平台通用字段。

2. 会话路由弱化
   - 现在依赖 replyTo 作为 chatId，适合最小场景，但不足以覆盖 topic / thread / group isolation 等真实 IM 需求。

3. 附件能力未抽象
   - 纯文本适配器无法覆盖图片、文件、卡片、富文本、分段流式输出。

4. delivery semantics 缺失
   - 现有 manager 已有 onDeliveryResult，但没有细化出站消息的统一状态机。

5. 平台差异被“泄漏”到了上层
   - 如果每个平台都掺杂自己的解析逻辑，上层业务会越来越脆弱。

## 3. 设计原则

### 3.1 先统一上层，再让平台实现差异化

上层业务应只依赖统一的概念：

- inbound message
- outbound message
- conversation context
- delivery status
- media attachments

平台差异只应存在于 adapter 内部完成映射。

### 3.2 以 Feishu 为参考，但不以 Feishu 绑定上层

Feishu 的群聊、私聊、@ 机器人、thread、card 都是很好的参考案例，但不应把 Feishu 的任何 API 细节强行硬编码进通用层。

### 3.3 采用 fail-closed 的权限和路由策略

在 allowFrom / sender validation / conversation routing 这些位置，默认保守：未授权、未识别、未映射的消息都应明确拒绝，不允许“静默接受”。

### 3.4 先做最小统一，再扩展平台特性

此设计不要求所有渠道在第一版都具备图片、文件、卡片与流式输出能力。第一阶段应优先完成：

- 文本入站 / 出站
- 私聊 / 群聊路由
- 允许列表与 bot 自身消息过滤
- delivery status

多媒体与流式能力作为第二阶段在 adapter 层逐步落地。

## 4. 范围

### 4.1 本次设计覆盖

- 通道消息模型扩展
- adapter 能力抽象
- inbound / outbound 统一契约
- Feishu 适配器的第一版能力目标
- 会话与 delivery 语义
- 未来扩展到其他 IM 平台的接口基线

### 4.2 本次设计不覆盖

- 具体平台的全部业务逻辑
- 机器人命令系统
- Agent session / Harness runtime 具体实现
- 一次性把所有 IM 平台都落地

## 5. 目标架构

### 5.1 分层

1. 通用 channels 层
   - 统一消息模型
   - 统一 adapter 接口
   - 统一 delivery 状态
   - 统一路由和 ACL

2. 平台 adapter 层
   - 负责解析平台事件
   - 负责将统一消息转换为平台的 API 请求
   - 负责平台特有能力的能力探测与严格拒绝

3. 业务层 / 应用层
   - 只消费统一消息，不关心平台细节

### 5.2 关键对象

- ChannelMessage：统一的通道消息对象
- ChannelAdapter：统一的适配器抽象
- ChannelManager：统一分发、路由、ACL、delivery 汇总
- ConversationContext：会话上下文
- DeliveryRecord：投递状态记录

## 6. 统一消息模型设计

### 6.1 新增通用字段

在现有 ChannelMessage 基础上增加下列字段。可选性只表示某类平台事件确实没有该语义，不表示允许用旧字段猜测或补造目标。

- conversationId：统一会话标识，平台无关；业务层视角的主键。
- chatId：平台会话目标；用于“向哪个会话回复”的发送地址。
- replyTo：用于发送时的回复目标；对外等价于 chatId 的首选发送地址。
- threadId：thread / topic / root 级别的会话上下文，可为空。
- senderType：user | bot | system | unknown
- messageType：text | image | file | card | event | unknown
- workspaceId：租户 / 工作区标识，可为空
- attachments：可选多媒体对象列表
- externalMessageId：平台原始消息 id
- metadata / platformMeta：平台差异数据保留区

注意：`conversationId` 是业务层的统一标识；`chatId` 与 `replyTo` 是平台层的发送目标，二者不必强制同值，但在同一 adapter 中应保持一致的语义。

### 6.2 消息对象建议

```ts
export interface ChannelMessage {
  id: string;
  channel: string;
  sender: string;
  content: string;
  timestamp: Date;

  // 统一业务语义：平台无关
  conversationId?: string;

  // 平台路由语义：平台相关
  chatId?: string;
  replyTo?: string;
  threadId?: string;
  externalMessageId?: string;

  // 发送者与消息类型
  senderType?: "user" | "bot" | "system" | "unknown";
  messageType?: "text" | "image" | "file" | "card" | "event" | "unknown";

  // 平台附件信息
  attachments?: ChannelAttachment[];

  // 平台域透传数据
  metadata?: Record<string, unknown>;
  platformMeta?: Record<string, unknown>;
  workspaceId?: string;
}
```

### 6.3 媒体对象建议

```ts
export interface ChannelAttachment {
  type: "image" | "file" | "audio" | "video" | "unknown";
  name?: string;
  mimeType?: string;
  url?: string;
  data?: Uint8Array | string;
  sizeBytes?: number;
  externalId?: string;
  metadata?: Record<string, unknown>;
}
```

## 7. 适配器能力枚举

适配器不应只有 send / onMessage，而应具备能力声明，以支持运行时的能力探测和严格拒绝。

### 7.1 能力枚举建议

```ts
export type ChannelCapability =
  | "text"
  | "image"
  | "file"
  | "rich-card"
  | "stream"
  | "mentions"
  | "threaded-conversation"
  | "group-chat"
  | "private-chat"
  | "delivery-status"
  | "acknowledgement"
  | "bot-skip-filter";
```

### 7.2 适配器能力接口建议

能力声明应作为 adapter 的可选 metadata，而不是强制所有适配器实现所有能力。

```ts
export interface ChannelAdapterCapabilities {
  supports: ChannelCapability[];
  maxTextLength?: number;
  supportsStreaming?: boolean;
  supportsFiles?: boolean;
  supportsImages?: boolean;
  supportsRichCards?: boolean;
  requiresMentionForGroupReply?: boolean;
}
```

其中，`supports` 可为空数组；不支持某个能力时，运行时应记录 warning 并返回明确错误，不得静默降级到另一种消息语义。

### 7.3 能力层级

- 基础能力：text
- 会话能力：private-chat / group-chat / threaded-conversation
- 多媒体能力：image / file
- 交互能力：rich-card / mentions / acknowledgement
- 运行时能力：stream / delivery-status / bot-skip-filter

适配器应该显式声明能力，而不是依赖运行时“碰运气”。这样能让 ChannelManager 在发送前就知道是否支持某种能力，并在不支持时拒绝该请求。

## 8. 统一 delivery 状态设计

### 8.1 状态集合

建议使用以下状态机，但在该项目中可先仅实现最小子集：

- pending
- sent
- failed
- unknown
- delivered

当前代码和业务语义中，最重要的仍是：

- sent
- failed
- unknown

保持与现有 ChannelManager 的 `onDeliveryResult` 一致即可，避免一次性引入过大的状态模型。

### 8.2 语义差异

- sent：平台明确确认成功
- failed：明确失败
- unknown：发送请求已发出，但平台未给出最终确认

这个语义要与当前 [packages/channels/src/core/manager.ts](../../../packages/channels/src/core/manager.ts) 的 onDeliveryResult 协定保持一致。

## 9. inbound / outbound 契约

### 9.1 inbound 契约

平台事件进入通道层后，必须统一为 ChannelMessage。

要求：

- 统一 sender 语义
- 统一 content 语义
- 统一 replyTo / chatId / conversationId
- 统一 metadata 透传
- 统一过滤 bot 自己消息和无效事件

### 9.2 outbound 契约

ChannelManager 产生的出站事件，应为统一业务层的消息内容，随后由 adapter 按平台能力转成实际请求。

例如：

- 业务层发出普通 text message
- Feishu adapter 转为 rich-text / markdown / card
- 若平台不支持，返回明确错误，不伪造另一种消息类型

## 10. Feishu 的首轮能力目标

Feishu 作为第一条实现样例，应在第一版实现“真实 IM 能力的最小通用集”，而不是复制完整 runtime。该阶段的目标应严格控制在：文本 + 路由 + delivery + 过滤。

### 10.1 目标能力

- text：支持纯文本
- group-chat：支持群聊消息接收
- private-chat：支持私聊消息接收
- mentions：支持识别 @ 机器人
- bot-skip-filter：过滤机器人自身消息
- delivery-status：支持发送结果回执
- threaded-conversation：支持 thread / root_id / thread_id 明确识别

### 10.2 目标行为

- 私聊消息：按 sender open_id 回复
- 群聊消息：按 chat_id 回复
- 仅在群聊中 @ 机器人时才触发回复（按配置）
- bot 自己消息直接跳过
- 接收重复 message_id 时保持幂等语义
- 发送时优先使用 replyTo，而不是 synthetic message id

### 10.3 目标要求

- FeishuAdapter 仍保持薄层，不做过多业务逻辑
- platform-specific parsing 封闭在 adapter 内部
- 下游业务只依赖统一 ChannelMessage

## 11. ChannelManager 的职责边界

ChannelManager 应保持统一职责：

- 维护 adapter registry
- 统一 start/stop lifecycle
- 统一 ACL 过滤
- 消息路由到正确 adapter
- 对 outbound 进行 delivery 状态回调
- 对不支持的能力进行 warning，而不是静默吞掉

它不应承担平台特定逻辑，例如：

- Feishu card serialization
- Feishu token refresh
- 企业微信回调签名验签
- Telegram markdown 兼容细节

这些都应下沉到对应 adapter。

## 12. 严格能力策略

### 12.1 平台能力

适配器不得在以下层面提供隐式降级：

- rich-card 不支持时不得回退到 text
- image 不支持时不得回退到 file
- thread 不支持时不得退回到 chat 基础会话

### 12.2 运行时策略

- 发送前检查 adapter 能力
- 若能力不支持，记录 warning 并返回明确错误
- 若平台返回未知状态，保留 delivery 为 unknown，不强制重试无限循环

## 13. 接口演进建议

### 阶段一：通用抽象收口（本次目标）

- 扩充 ChannelMessage 的可选字段
- 为 adapter 提供能力声明
- 明确 delivery 状态与 ChannelManager 行为
- 完成私聊/群聊路由与 bot 消息过滤

### 阶段二：Feishu 提升为真实 IM adapter

- 增加 topic/thread 语义
- 增加 image/file 发送能力
- 增加 mention / bot skip 处理
- 细化 outbound/inbound mapping

### 阶段三：其他平台接入

- Telegram
- Slack
- Discord
- 微信 / 企业微信 / 钉钉

在此阶段，各个平台只需实现 adapter 映射，而不改变上层业务协议。

## 14. 验收标准

1. 通道层能够在统一消息模型上支持私聊和群聊语义。
2. adapter 能显式声明支持的能力，并在运行时拒绝不支持的能力。
3. Feishu adapter 能在统一契约下处理文本消息收发、@ 机器人过滤、group/private 路由和重复消息的幂等语义。
4. ChannelManager 能在一处维护 ACL、路由和 delivery 状态。
5. 平台特异逻辑不泄漏到上层业务。

## 15. 自检

本设计已检查以下问题：

- 范围是否聚焦在 channels 抽象层，而不是平台业务实现？ 是，且已收紧到第一阶段的最小真实需求。
- 是否覆盖真实 IM 常见交互模式？ 是，私聊 / 群聊 / thread / mentions / delivery / media 仍保留为后续扩展重点。
- 是否保留未来扩展性？ 是，能力枚举和 adapter 层已规范化，但不强求全能力实现。
- 是否避免过度落地到某个具体平台？ 是，设计以通用模型为核心，并保留 Feishu 作为样例。

## 16. 下一步

下一步将按本设计进入实现计划阶段，优先落地：

1. ChannelMessage 扩展模型
2. ChannelAdapter 能力声明
3. FeishuAdapter 对应能力补齐
4. ChannelManager 对 delivery 与 ACL 的强化

在此之前，建议先确认：

- 是否接受“通用 IM runtime”作为这次 channels 扩展的主线
- 是否希望把 Feishu 与其他平台的能力枚举一起纳入正式实现计划

如果你确认这个方向，我将继续把它整理成详细的实现计划，并开始落到代码任务。 
