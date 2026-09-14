export interface PluginArchiveSelection {
  id: string
  cwd: string
  archivePath: string
  archiveDigest: string
  pluginName: string
  requestedPermissions: string[]
  createdAt: number
  expiresAt: number
}

export interface PluginGitSelection {
  id: string
  cwd: string
  url: string
  ref?: string
  sourceDigest: string
  pluginName: string
  requestedPermissions: string[]
  createdAt: number
  expiresAt: number
}

export class PluginArchiveSelectionStore {
  private readonly selections = new Map<string, PluginArchiveSelection>()

  constructor(
    private readonly now: () => number,
    private readonly maxSelections = 8
  ) {}

  add(selection: PluginArchiveSelection): void {
    this.removeExpired()
    while (this.selections.size >= this.maxSelections) {
      const oldestId = this.selections.keys().next().value
      if (!oldestId) break
      this.selections.delete(oldestId)
    }
    this.selections.set(selection.id, selection)
  }

  consume(selectionId: string): PluginArchiveSelection | undefined {
    const selection = this.selections.get(selectionId)
    if (!selection) return undefined
    this.selections.delete(selectionId)
    return selection.expiresAt > this.now() ? selection : undefined
  }

  cancel(selectionId: string): void {
    this.selections.delete(selectionId)
  }

  clear(): void {
    this.selections.clear()
  }

  private removeExpired(): void {
    for (const [id, selection] of this.selections) {
      if (selection.expiresAt <= this.now()) this.selections.delete(id)
    }
  }
}

export class PluginGitSelectionStore {
  private readonly selections = new Map<string, PluginGitSelection>()

  constructor(
    private readonly now: () => number,
    private readonly maxSelections = 8
  ) {}

  add(selection: PluginGitSelection): void {
    this.removeExpired()
    while (this.selections.size >= this.maxSelections) {
      const oldestId = this.selections.keys().next().value
      if (!oldestId) break
      this.selections.delete(oldestId)
    }
    this.selections.set(selection.id, selection)
  }

  consume(selectionId: string): PluginGitSelection | undefined {
    const selection = this.selections.get(selectionId)
    if (!selection) return undefined
    this.selections.delete(selectionId)
    return selection.expiresAt > this.now() ? selection : undefined
  }

  cancel(selectionId: string): void {
    this.selections.delete(selectionId)
  }

  clear(): void {
    this.selections.clear()
  }

  private removeExpired(): void {
    for (const [id, selection] of this.selections) {
      if (selection.expiresAt <= this.now()) this.selections.delete(id)
    }
  }
}
