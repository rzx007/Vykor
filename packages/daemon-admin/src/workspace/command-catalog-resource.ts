import type { HttpTransport } from "@rzx/client";
import type { CommandCatalogEntry, ListCommandsOptions } from "./types.js";

export class CommandCatalogResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /commands` */
  async listCommands(
    options: ListCommandsOptions & { signal?: AbortSignal },
  ): Promise<CommandCatalogEntry[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{ commands: CommandCatalogEntry[] }>(
      this.transport.path("/commands", query),
      { signal },
    );
    return response.commands;
  }
}
