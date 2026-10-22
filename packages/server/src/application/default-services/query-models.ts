/** Facts reported by the environment capability resolver. */
export interface AgentEnvironmentCapabilities { native: true; wsl: boolean; activeDefault?: { kind: "native" | "wsl"; distribution?: string; fingerprint: string } }
