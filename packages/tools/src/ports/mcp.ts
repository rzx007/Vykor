import type {
  McpAuthConfigureInput,
  McpAuthConfigureResult,
  ToolContext,
} from "@vykor/core";

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
