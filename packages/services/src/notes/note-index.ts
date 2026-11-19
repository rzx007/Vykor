export interface NoteIndexEntry {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  sha256: string;
  deletedAt: number | null;
}

export interface EmbeddedNote {
  id: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface NoteIndex {
  /** Hold the index writer lock while reconciling or replacing a Markdown file. */
  atomic<T>(work: () => T): T;
  deferUntilRollback(work: () => void): void;
  deferUntilCommit(work: () => void): void;
  get(id: string): NoteIndexEntry | undefined;
  entries(): NoteIndexEntry[];
  save(entry: NoteIndexEntry): void;
}
