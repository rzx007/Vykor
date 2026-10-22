import type { AgentDefinition } from "./definitions/types.js";
import type { CoordinatorConfig, CoordinatorMode } from "./types.js";

export class Coordinator {
  private config: CoordinatorConfig;

  constructor(config: CoordinatorConfig) {
    this.config = config;
  }

  getAgents(): AgentDefinition[] {
    return this.config.agents;
  }

  getMode(): CoordinatorMode {
    return this.config.mode;
  }
}
