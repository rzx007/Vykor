import { createHash } from "node:crypto";
import type { Message, StreamMessageParams, StreamingMessageClient, UsageSnapshot } from "@vykor/agent-contracts";
import type { QueryRequestConfiguration } from "../../types/runtime";

interface InputBoundary {
  client: StreamingMessageClient;
  configurationHash: string;
  historyHash: string;
  messageCount: number;
}

function historyHash(messages: readonly Message[], count = messages.length): string {
  const hash = createHash("sha256");
  for (let index = 0; index < count; index++) hash.update(JSON.stringify(messages[index])).update("\n");
  return hash.digest("hex");
}

function configurationHash(request: StreamMessageParams, configuration: QueryRequestConfiguration): string {
  return createHash("sha256").update(JSON.stringify({
    model: request.model, provider: configuration.provider, baseUrl: configuration.baseUrl,
    apiFormat: configuration.apiFormat, system: request.system,
    tools: request.tools?.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    maxTokens: request.maxTokens, temperature: request.temperature, reasoningEffort: request.reasoningEffort,
    effort: configuration.effort, replyStyle: configuration.replyStyle, supportsImageInput: configuration.supportsImageInput,
  })).digest("hex");
}

/** A disposable observation of one request prefix, never a second conversation state. */
export class ContextInputMeasurement {
  private latest: (InputBoundary & { inputTokens: number }) | undefined;

  capture(request: StreamMessageParams, configuration: QueryRequestConfiguration, messages: readonly Message[]): InputBoundary {
    return { client: configuration.client, configurationHash: configurationHash(request, configuration),
      historyHash: historyHash(messages), messageCount: messages.length };
  }

  record(boundary: InputBoundary, usage: UsageSnapshot | undefined): void {
    const metering = usage?.metering;
    // knownInputTokens is already normalized: providers with separate cache
    // fields add them there; providers whose input includes cache do not.
    this.latest = metering?.completeness === "complete" && !usage?.usageIncomplete
      && Number.isSafeInteger(metering.knownInputTokens) && metering.knownInputTokens >= 0
      ? { ...boundary, inputTokens: metering.knownInputTokens } : undefined;
  }

  estimate(request: StreamMessageParams, configuration: QueryRequestConfiguration,
    messages: readonly Message[], estimateMessages: (messages: Message[]) => number): number | undefined {
    const latest = this.latest;
    if (!latest || latest.client !== configuration.client || messages.length < latest.messageCount
      || configurationHash(request, configuration) !== latest.configurationHash
      || historyHash(messages, latest.messageCount) !== latest.historyHash) return undefined;
    // Estimate actual request-only image replacements, not the original images.
    return latest.inputTokens + estimateMessages(request.messages.slice(latest.messageCount));
  }

  clear(): void { this.latest = undefined; }
}
