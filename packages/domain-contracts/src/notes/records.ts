export const MAX_NOTE_CONTENT_LENGTH = 100_000;

export interface NoteRecord {
  id: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateNoteInput {
  content: string;
}

export interface UpdateNoteInput {
  content: string;
  expectedRevision: number;
}
