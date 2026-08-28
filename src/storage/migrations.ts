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
  {
    version: 2,
    sql: `
      CREATE TABLE thread_leases (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        owner_pid INTEGER NOT NULL CHECK(owner_pid > 0),
        owner_hostname TEXT NOT NULL,
        owner_token TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        revision TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions > 0),
        pooling TEXT NOT NULL,
        embedding_version INTEGER NOT NULL CHECK(embedding_version > 0),
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(length(embedding) = dimensions * 4)
      );

      CREATE INDEX memory_embeddings_model_idx
        ON memory_embeddings(model, revision, dimensions, pooling, embedding_version);

      CREATE TABLE memory_vector_state (
        workspace_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
        updated_at TEXT NOT NULL
      );

      CREATE TRIGGER memories_vector_state_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memory_vector_state(workspace_id, generation, updated_at)
        VALUES (new.workspace_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(workspace_id) DO UPDATE SET
          generation = memory_vector_state.generation + 1,
          updated_at = excluded.updated_at;
      END;

      CREATE TRIGGER memories_vector_state_update
      AFTER UPDATE OF workspace_id, category, content, normalized_content, confidence, status
      ON memories BEGIN
        INSERT INTO memory_vector_state(workspace_id, generation, updated_at)
        VALUES (new.workspace_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(workspace_id) DO UPDATE SET
          generation = memory_vector_state.generation + 1,
          updated_at = excluded.updated_at;

        INSERT INTO memory_vector_state(workspace_id, generation, updated_at)
        SELECT old.workspace_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE old.workspace_id <> new.workspace_id
        ON CONFLICT(workspace_id) DO UPDATE SET
          generation = memory_vector_state.generation + 1,
          updated_at = excluded.updated_at;
      END;

      CREATE TRIGGER memories_vector_state_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memory_vector_state(workspace_id, generation, updated_at)
        VALUES (old.workspace_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ON CONFLICT(workspace_id) DO UPDATE SET
          generation = memory_vector_state.generation + 1,
          updated_at = excluded.updated_at;
      END;

      CREATE TRIGGER memory_embeddings_vector_state_insert
      AFTER INSERT ON memory_embeddings BEGIN
        INSERT INTO memory_vector_state(workspace_id, generation, updated_at)
        SELECT workspace_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          FROM memories WHERE id = new.memory_id
        ON CONFLICT(workspace_id) DO UPDATE SET
          generation = memory_vector_state.generation + 1,
          updated_at = excluded.updated_at;
      END;

      CREATE TRIGGER memory_embeddings_vector_state_update
      AFTER UPDATE OF model, revision, dimensions, pooling, embedding_version,
                      content_hash, embedding
      ON memory_embeddings BEGIN
        INSERT INTO memory_vector_state(workspace_id, generation, updated_at)
        SELECT workspace_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          FROM memories WHERE id = new.memory_id
        ON CONFLICT(workspace_id) DO UPDATE SET
          generation = memory_vector_state.generation + 1,
          updated_at = excluded.updated_at;
      END;

      CREATE TRIGGER memory_embeddings_vector_state_delete
      AFTER DELETE ON memory_embeddings BEGIN
        INSERT INTO memory_vector_state(workspace_id, generation, updated_at)
        SELECT workspace_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          FROM memories WHERE id = old.memory_id
        ON CONFLICT(workspace_id) DO UPDATE SET
          generation = memory_vector_state.generation + 1,
          updated_at = excluded.updated_at;
      END;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE tool_audit ADD COLUMN source_agent_role TEXT;
      ALTER TABLE tool_audit ADD COLUMN source_agent_id TEXT;
      ALTER TABLE tool_audit ADD COLUMN source_task_id TEXT;

      CREATE INDEX tool_audit_source_agent_idx
        ON tool_audit(thread_id, source_agent_id, timestamp);
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
