export type BrowserAction =
  | { action: "inspect" }
  | { action: "navigate"; url: string }
  | { action: "click"; elementId: string }
  | { action: "type"; elementId: string; text: string }
  | { action: "scroll"; direction: "up" | "down"; amount?: number };

export interface BrowserObservation {
  url: string;
  title: string;
  pageText: string;
  elements?: Array<{
    id: string;
    role: string;
    name: string;
    href?: string;
    value?: string;
    requiresConfirmation?: boolean;
  }>;
  screenshotBytes?: Uint8Array;
  annotations?: Array<{ target: string; comment: string; selector: string }>;
}

/** The only developer inspections the agent may request. Never a raw CDP method. */
export type BrowserDeveloperAction =
  | { action: "inspect_dom"; selector?: string }
  | { action: "inspect_styles"; selector: string }
  | { action: "start_diagnostics" }
  | { action: "read_diagnostics" }
  | { action: "stop_diagnostics" };

export interface BrowserDeveloperResult {
  action: BrowserDeveloperAction["action"];
  url: string;
  data: unknown;
  truncated?: boolean;
}

export interface BrowserDeveloperExecuteInput {
  action: BrowserDeveloperAction;
  sessionId: string;
  cwd: string;
  /** Ordinary, reusable-or-not site approval under the existing Browser tool name. */
  approveOrigin: (reason: string) => Promise<boolean>;
  /** A separate, once-only developer approval for this single inspection. */
  approveDeveloper: (reason: string) => Promise<boolean>;
}

export interface BrowserHost {
  execute(input: {
    action: BrowserAction;
    sessionId: string;
    cwd: string;
    includeScreenshot: boolean;
    approve: (question: string) => Promise<boolean>;
  }): Promise<BrowserObservation>;
  /**
   * Optional so CLI/standalone hosts without a Desktop browser remain valid.
   * Absent means developer inspection is unavailable and must fail closed.
   */
  executeDeveloper?(input: BrowserDeveloperExecuteInput): Promise<BrowserDeveloperResult>;
}
