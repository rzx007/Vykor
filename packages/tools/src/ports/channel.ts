export interface FeishuChannelPort {
  getFeishu(): Promise<
    | {
        enabled?: boolean;
        appId: string;
        appSecret: string;
        domain?: "feishu" | "lark";
        allowFrom: Record<string, string>;
      }
    | undefined
  >;
}
