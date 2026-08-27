import type { SqliteDatabase } from "./sqlite-database.js";

interface Migration {
  readonly version: number;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        workspace_root TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        goal TEXT,
        constraints_json TEXT NOT NULL DEFAULT '[]',
        working_summary TEXT NOT NULL DEFAULT '',
        active_turn_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX threads_workspace_updated_idx
        ON threads(workspace_id, updated_at DESC);

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        user_message_json TEXT,
        assistant_message_json TEXT,
        result_reason TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX turns_thread_started_idx
        ON turns(thread_id, started_at);

      CREATE TABLE item_index (
        event_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        phase TEXT,
        timestamp TEXT NOT NULL,
        journal_path TEXT NOT NULL,
        UNIQUE(thread_id, sequence)
      );

      CREATE INDEX item_index_thread_sequence_idx
        ON item_index(thread_id, sequence);

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        normalized_content TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        evidence TEXT,
        source_thread_id TEXT,
        source_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(workspace_id, normalized_content)
      );

      CREATE INDEX memories_workspace_status_idx
        ON memories(workspace_id, status, updated_at DESC);

      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        category,
        content='memories',
        content_rowid='rowid',
        tokenize='unicode61'
      );

      CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.rowid, new.content, new.category);
      END;

      CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.rowid, old.content, old.category);
      END;

      CREATE TRIGGER memories_fts_update AFTER UPDATE OF content, category ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, category)
        VALUES ('delete', old.rowid, old.content, old.category);
        INSERT INTO memories_fts(rowid, content, category)
        VALUES (new.rowid, new.content, new.category);
      END;

      CREATE TABLE tool_audit (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT,
        program TEXT NOT NULL,
        args_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        duration_ms INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        summary TEXT NOT NULL
      );

      CREATE INDEX tool_audit_thread_timestamp_idx
        ON tool_audit(thread_id, timestamp);
    `,
  },
];

export function runMigrations(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .prepare<[], { version: number }>("SELECT version FROM schema_migrations")
    .all();
  const applied = new Set(appliedRows.map((row) => row.version));
  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run(migration.version, new Date().toISOString());
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
