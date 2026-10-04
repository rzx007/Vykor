import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "../session-runtime/schema.js";
import { applySessionMigrations } from "./migrations.js";

export interface SessionDatabaseOptions {
  path: string;
}

export class SessionDatabase {
  readonly path: string;
  readonly connection: Database.Database;
  readonly orm: BetterSQLite3Database<typeof schema>;

  private constructor(path: string, connection: Database.Database) {
    this.path = path;
    this.connection = connection;
    this.orm = drizzle(connection, { schema });
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
      applySessionMigrations(connection);
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
