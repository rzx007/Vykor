import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  applySessionMigrations,
  assertCurrentStorageFormat,
  assertCurrentStorageFormatOrEmpty,
} from "./migrations.js";

export interface SessionDatabaseOptions {
  path: string;
}

export class SessionDatabase {
  readonly path: string;
  readonly connection: Database.Database;

  private constructor(path: string, connection: Database.Database) {
    this.path = path;
    this.connection = connection;
  }

  static open(options: SessionDatabaseOptions): SessionDatabase {
    const path = resolve(options.path);
    mkdirSync(dirname(path), { recursive: true });
    const connection = new Database(path);
    try {
      connection.pragma("journal_mode = WAL");
      connection.pragma("foreign_keys = ON");
      connection.pragma("busy_timeout = 5000");
      connection.pragma("synchronous = NORMAL");
      assertCurrentStorageFormatOrEmpty(connection);
      applySessionMigrations(connection);
      assertCurrentStorageFormat(connection);
      return new SessionDatabase(path, connection);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }
}
