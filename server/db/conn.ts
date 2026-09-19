import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config, rootDirPath } from "../config.js";

// Load through the .cjs shim so bundlers/test runners that don't know
// node:sqlite never try to inline it.
const requireSqlite = createRequire(import.meta.url);
const sqliteModule = requireSqlite("./sqlite.cjs") as typeof import("node:sqlite");
const DatabaseSyncCtor = sqliteModule.DatabaseSync;

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  if (config.databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  }
  db = new DatabaseSyncCtor(config.databasePath) as DatabaseSync;
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
  }
}

export const rootDirForMigrations = rootDirPath;