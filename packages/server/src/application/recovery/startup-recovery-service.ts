export interface StartupRecoveryServiceOptions {
  recoverProjectionSettlements(): void;
  recoverPluginUiActions?(): void;
  interruptActiveRuns(): void;
  failIncompleteReviewsOnStartup?(): number;
  pauseActiveGoals(): void;
  terminalizeUnownedInputs(): void;
  expirePendingPermissions(): void;
  finalizeClosingSessions(): void;
  recoverAttachments(): Promise<unknown>;
  reconcileBackgroundTasks(): Promise<unknown>;
  recoverGoalWaits(): void;
  recoverWorkflows(): Promise<unknown>;
}

/** Runs durable recovery in the same explicit order on every daemon start. */
export class StartupRecoveryService {
  constructor(private readonly options: StartupRecoveryServiceOptions) {}

  async run(): Promise<void> {
    this.options.recoverProjectionSettlements();
    this.options.recoverPluginUiActions?.();
    this.options.interruptActiveRuns();
    this.options.failIncompleteReviewsOnStartup?.();
    this.options.pauseActiveGoals();
    this.options.terminalizeUnownedInputs();
    this.options.expirePendingPermissions();
    this.options.finalizeClosingSessions();
    await Promise.all([
      this.options.recoverAttachments(),
      this.options.reconcileBackgroundTasks(),
    ]);
    this.options.recoverGoalWaits();
    await this.options.recoverWorkflows();
  }
}
