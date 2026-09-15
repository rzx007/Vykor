export interface StartupRecoveryServiceOptions {
  recoverProjectionSettlements(): void;
  interruptActiveRuns(): void;
  pauseActiveGoals(): void;
  terminalizeUnownedInputs(): void;
  expirePendingPermissions(): void;
  finalizeClosingSessions(): void;
  recoverAttachments(): Promise<unknown>;
  reconcileBackgroundTasks(): Promise<unknown>;
  recoverWorkflows(): Promise<unknown>;
}

/** Runs durable recovery in the same explicit order on every daemon start. */
export class StartupRecoveryService {
  constructor(private readonly options: StartupRecoveryServiceOptions) {}

  async run(): Promise<void> {
    this.options.recoverProjectionSettlements();
    this.options.interruptActiveRuns();
    this.options.pauseActiveGoals();
    this.options.terminalizeUnownedInputs();
    this.options.expirePendingPermissions();
    this.options.finalizeClosingSessions();
    await Promise.all([
      this.options.recoverAttachments(),
      this.options.reconcileBackgroundTasks(),
    ]);
    await this.options.recoverWorkflows();
  }
}
