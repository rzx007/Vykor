import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { subscribeAppResource } from "./resource-subscriptions.js";
import type {
  ReadResourceResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
} from "@modelcontextprotocol/sdk/types.js";
import { PLUGIN_APP_LIMITS, PLUGIN_APP_HTML_MIME_TYPE } from "@vykor/protocol";

/** Captured concrete client, never name-based dispatch to a replacement connection. No tool invocation. */
export interface CapturedMcpAppResources {
  readonly generation: string;
  readonly supportsSubscriptions: boolean;
  isCurrent(): boolean;
  subscribeResource?(
    uri: string,
    listener: () => void,
    signal: AbortSignal,
  ): Promise<() => void>;
  readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult>;
  listResources(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ListResourcesResult>;
  listResourceTemplates(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ListResourceTemplatesResult>;
}

export function captureMcpAppResources(
  client: Client,
  generation: string,
  isCurrent: () => boolean,
): CapturedMcpAppResources {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("plugin_app_backend_changed");
  };
  const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
    assertCurrent();
    const result = await call();
    assertCurrent();
    return result;
  };
  const resources = client.getServerCapabilities()?.resources;
  return Object.freeze({
    generation,
    isCurrent,
    supportsSubscriptions: resources?.subscribe === true,
    ...(resources?.subscribe === true
      ? {
          subscribeResource: (
            uri: string,
            listener: () => void,
            signal: AbortSignal,
          ) => {
            assertCurrent();
            return subscribeAppResource(
              client,
              uri,
              listener,
              isCurrent,
              signal,
            );
          },
        }
      : {}),
    readResource: (uri: string, signal?: AbortSignal) =>
      guarded(async () => {
        const result = await client.readResource(
          { uri },
          signal ? { signal } : undefined,
        );
        const html =
          result.contents.length === 1 &&
          result.contents[0]?.mimeType === PLUGIN_APP_HTML_MIME_TYPE;
        const limit = html
          ? PLUGIN_APP_LIMITS.htmlBytes
          : PLUGIN_APP_LIMITS.resourceBytes;
        let decodedBytes = 0;
        for (const content of result.contents) {
          if (content.uri !== uri)
            throw new Error("plugin_app_resource_uri_mismatch");
          if ("text" in content && typeof content.text === "string")
            decodedBytes += Buffer.byteLength(content.text, "utf8");
          else if ("blob" in content && typeof content.blob === "string") {
            if (content.blob.length > Math.ceil((limit - decodedBytes) / 3) * 4)
              throw new Error("plugin_app_resource_too_large");
            if (content.blob.length % 4 || /[^A-Za-z0-9+/=]/.test(content.blob))
              throw new Error("plugin_app_resource_invalid_blob");
            const bytes = Buffer.from(content.blob, "base64");
            if (bytes.toString("base64") !== content.blob)
              throw new Error("plugin_app_resource_invalid_blob");
            decodedBytes += bytes.byteLength;
          } else throw new Error("plugin_app_resource_invalid_content");
          if (decodedBytes > limit)
            throw new Error("plugin_app_resource_too_large");
        }
        return result;
      }),
    listResources: (cursor?: string, signal?: AbortSignal) =>
      guarded(() =>
        resources
          ? client.listResources(
              cursor ? { cursor } : {},
              signal ? { signal } : undefined,
            )
          : Promise.resolve({ resources: [] }),
      ),
    listResourceTemplates: (cursor?: string, signal?: AbortSignal) =>
      guarded(() =>
        resources
          ? client.listResourceTemplates(
              cursor ? { cursor } : {},
              signal ? { signal } : undefined,
            )
          : Promise.resolve({ resourceTemplates: [] }),
      ),
  });
}
