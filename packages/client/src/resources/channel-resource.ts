import type {
  ChannelDeliveryRecord,
  ChannelStatusSnapshot,
  DurableChannelMessageInput,
  DurableChannelMessageResult,
  RecordChannelDeliveryInput,
} from "@openharness/protocol";
import type { HttpTransport } from "../transport/http-transport.js";

export class ChannelResource {
  constructor(private readonly transport: HttpTransport) {}

  async handleMessage(
    input: DurableChannelMessageInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<DurableChannelMessageResult> {
    return await this.transport.request<DurableChannelMessageResult>(
      "/channels/messages",
      { method: "POST", body: input, signal: options.signal },
    );
  }

  async recordDelivery(
    deliveryId: string,
    input: RecordChannelDeliveryInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ChannelDeliveryRecord> {
    const response = await this.transport.request<{ delivery: ChannelDeliveryRecord }>(
      `/channels/deliveries/${encodeURIComponent(deliveryId)}/result`,
      { method: "POST", body: input, signal: options.signal },
    );
    return response.delivery;
  }

  async getStatus(
    options: { connector?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChannelStatusSnapshot> {
    const { signal, ...query } = options;
    return await this.transport.request<ChannelStatusSnapshot>(
      this.transport.path("/channels/status", query),
      { signal },
    );
  }

  async listPendingDeliveries(
    options: { connector?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChannelDeliveryRecord[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{
      deliveries: ChannelDeliveryRecord[];
    }>(this.transport.path("/channels/deliveries/pending", query), { signal });
    return response.deliveries;
  }
}
