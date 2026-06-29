//! Persistent agent memory (goal M0.4).
//!
//! A small SQLite store under `<project_dir>/memory.db` that the chat loop
//! exposes as three tools: `memory_write`, `memory_read`, `memory_search`.
//! Memories written in one session are recalled in the next — survives app
//! restarts (unlike the in-process permission cache).
//!
//! Single connection behind a Mutex: writes are rare (the model jots a note),
//! reads are cheap, and SQLite itself is the durability boundary. Wrapped in
//! Arc and held in AppState.

use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::Connection;

#[derive(Debug)]
pub struct MemoryStore {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryRow {
    pub key: String,
    pub content: String,
    pub updated_at: i64,
}

impl MemoryStore {
    /// Open (and migrate) the memory DB at `<project_dir>/memory.db`. Falls
    /// back to an in-memory DB if the path can't be opened, so a read-only
    /// FS never breaks the sidecar (memory just won't persist).
    pub fn open(project_dir: &Path) -> Self {
        let path = project_dir.join("memory.db");
        let conn = std::fs::create_dir_all(project_dir)
            .ok()
            .and_then(|_| Connection::open(&path).ok())
            .unwrap_or_else(|| {
                Connection::open_in_memory().expect("in-memory sqlite always opens")
            });
        Self::migrate(&conn);
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// Test/ephemeral store with no file backing.
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        Self::migrate(&conn);
        Self {
            conn: Mutex::new(conn),
        }
    }

    fn migrate(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS memories (
                key        TEXT PRIMARY KEY,
                content    TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);",
        )
        .expect("memory schema migration");
    }

    fn now() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// Upsert a memory under `key`. Returns whether it was an insert (true) or
    /// an update (false).
    pub fn write(&self, key: &str, content: &str) -> Result<bool> {
        let key = key.trim();
        if key.is_empty() {
            anyhow::bail!("memory key must not be empty");
        }
        let now = Self::now();
        let conn = self.conn.lock().expect("memory mutex poisoned");
        let existed: bool = conn
            .query_row("SELECT 1 FROM memories WHERE key = ?1", [key], |_| Ok(true))
            .unwrap_or(false);
        conn.execute(
            "INSERT INTO memories(key, content, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?3)
             ON CONFLICT(key) DO UPDATE SET content = ?2, updated_at = ?3",
            rusqlite::params![key, content, now],
        )
        .context("memory write")?;
        Ok(!existed)
    }

    /// Read a memory by exact key.
    pub fn read(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("memory mutex poisoned");
        let res = conn
            .query_row(
                "SELECT content FROM memories WHERE key = ?1",
                [key.trim()],
                |r| r.get::<_, String>(0),
            )
            .ok();
        Ok(res)
    }

    /// Substring search over key + content, newest first.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<MemoryRow>> {
        let conn = self.conn.lock().expect("memory mutex poisoned");
        let like = format!("%{}%", query.trim().replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = conn.prepare(
            "SELECT key, content, updated_at FROM memories
             WHERE key LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\'
             ORDER BY updated_at DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![like, limit as i64], |r| {
                Ok(MemoryRow {
                    key: r.get(0)?,
                    content: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// List the most recently updated memories (for a "what do you remember"
    /// affordance).
    pub fn recent(&self, limit: usize) -> Result<Vec<MemoryRow>> {
        let conn = self.conn.lock().expect("memory mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT key, content, updated_at FROM memories ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([limit as i64], |r| {
                Ok(MemoryRow {
                    key: r.get(0)?,
                    content: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_roundtrip_and_upsert() {
        let m = MemoryStore::in_memory();
        assert!(m.write("fav-organism", "Drosophila melanogaster").unwrap()); // insert
        assert_eq!(
            m.read("fav-organism").unwrap().as_deref(),
            Some("Drosophila melanogaster")
        );
        assert!(!m.write("fav-organism", "E. coli K-12").unwrap()); // update
        assert_eq!(
            m.read("fav-organism").unwrap().as_deref(),
            Some("E. coli K-12")
        );
        assert!(m.read("missing").unwrap().is_none());
    }

    #[test]
    fn search_matches_key_and_content() {
        let m = MemoryStore::in_memory();
        m.write("project-x", "uses RNAGenesis for aptamer design")
            .unwrap();
        m.write("project-y", "FoldMark watermarking pipeline")
            .unwrap();
        let hits = m.search("aptamer", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].key, "project-x");
        let by_key = m.search("project", 10).unwrap();
        assert_eq!(by_key.len(), 2);
    }

    #[test]
    fn empty_key_rejected() {
        let m = MemoryStore::in_memory();
        assert!(m.write("  ", "x").is_err());
    }

    #[test]
    fn persists_across_reopen() {
        let dir = std::env::temp_dir().join(format!("bioclaw-mem-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            let m = MemoryStore::open(&dir);
            m.write("k", "remembered").unwrap();
        }
        let m2 = MemoryStore::open(&dir);
        assert_eq!(m2.read("k").unwrap().as_deref(), Some("remembered"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
