/** Plugin packaging declarations. Runtime identities and execution authority are host-owned. */
export interface PluginAppResourceDefinition {
  uri: string;
  entry: string;
}

export interface PluginAppNativeToolDefinition {
  tool: string;
  visibility: Array<"model" | "app">;
  ui?: { resourceUri: string };
}

/** Exact installed declaration. It never grants authority on its own. */
export interface PluginAppToolPolicyDefinition {
  tool: string;
  authorization?: "plugin-data-write";
  maxArgumentsBytes?: number;
}

export interface PluginAppNativeBackendDefinition {
  id: string;
  kind: "native-tools";
  resources: PluginAppResourceDefinition[];
  tools: PluginAppNativeToolDefinition[];
  toolPolicies?: PluginAppToolPolicyDefinition[];
}

export interface PluginAppMcpBackendDefinition {
  id: string;
  kind: "mcp-server";
  server: string;
  toolPolicies?: PluginAppToolPolicyDefinition[];
}

export type PluginAppBackendDefinition = PluginAppNativeBackendDefinition | PluginAppMcpBackendDefinition;

export interface PluginAppSurfaceDefinition {
  id: string;
  title: string;
  backend: string;
  resourceUri: string;
  availability: "session";
}

export interface PluginAppManifest {
  schemaVersion: 1;
  backends: PluginAppBackendDefinition[];
  surfaces: PluginAppSurfaceDefinition[];
}


export type PluginAppBackendKind = PluginAppBackendDefinition["kind"];
