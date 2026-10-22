import type { McpAuthConfigureInput, McpAuthConfigureResult } from "./host.js";
import type { ToolContext } from "@vykor/agent-contracts";

export interface McpResourceDescription {
  serverName: string;
  name: string;
  uri: string;
}
export interface McpToolPort {
  listResources(
    context: ToolContext,
  ): readonly McpResourceDescription[] | undefined;
  readResource(
    serverName: string,
    uri: string,
    context: ToolContext,
  ): Promise<string>;
  configureAuth(
    input: McpAuthConfigureInput,
    context: ToolContext,
  ): Promise<McpAuthConfigureResult>;
}
