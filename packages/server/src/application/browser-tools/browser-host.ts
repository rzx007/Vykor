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
  annotations?: Array<{ target: string; comment: string }>;
}

export interface BrowserHost {
  execute(input: {
    action: BrowserAction;
    sessionId: string;
    cwd: string;
    includeScreenshot: boolean;
    approve: (question: string) => Promise<boolean>;
  }): Promise<BrowserObservation>;
}
