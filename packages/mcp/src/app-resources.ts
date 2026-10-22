import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { subscribeAppResource } from "./resource-subscriptions.js";
import type {
  ReadResourceResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
} from "@modelcontextprotocol/sdk/types.js";
import { PLUGIN_APP_RESOURCE_LIMITS } from "@vykor/plugin-contracts/limits";
import { validatePluginAppResourceContents } from "@vykor/plugin-contracts/validation";
import type { PluginAppResourceLimits } from "@vykor/plugin-contracts/limits";

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
  limits: PluginAppResourceLimits = PLUGIN_APP_RESOURCE_LIMITS,
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
        const validation = validatePluginAppResourceContents(result, uri, {
          htmlBytes: Math.min(limits.htmlBytes, PLUGIN_APP_RESOURCE_LIMITS.htmlBytes),
          resourceBytes: Math.min(limits.resourceBytes, PLUGIN_APP_RESOURCE_LIMITS.resourceBytes),
        });
        if (!validation.ok) throw new Error(validation.code);
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
