/** 同一个平台消息在所有重试中得到同一个 durable Input id。 */
export function durableChannelInputId(input: {
  connector: string;
  accountId: string;
  externalMessageId: string;
}): string {
  return ["channel", input.connector, input.accountId, input.externalMessageId]
    .map((part) => encodeURIComponent(part.trim()))
    .join(":");
}
