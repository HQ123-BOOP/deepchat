//! SQLite 主存储：会话、附件、识别文本与全文搜索。
//!
//! 所有数据原本在 WebView 的 IndexedDB 里，Rust 无法直接访问；迁移到 SQLite 后，
//! 搜索直接在 Rust 侧做（类似 ripgrep：全表读出 + 大小写不敏感的子串匹配）。
//! 会话本体以 JSON 文本整存整取，与前端「整会话保存」的写模式一致。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct Db(Mutex<Connection>);

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_summaries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL DEFAULT '',
  bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS file_texts (
  id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
-- 附件引用索引：删除会话时判断原件是否仍被其他会话引用
CREATE TABLE IF NOT EXISTS file_refs (
  session_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (session_id, file_id)
);
-- 搜索文本：每个会话一行，标题单列，正文为全部可展示文本的拼接
CREATE TABLE IF NOT EXISTS search_texts (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions_staging (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS files_staging (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL DEFAULT '',
  bytes BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_updated ON session_summaries (updated_at DESC, id DESC);
";

fn open_connection(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
    conn.pragma_update(None, "synchronous", "NORMAL").map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn init(app: &tauri::App) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let conn = open_connection(&dir.join("chat.sqlite3"))?;
    app.manage(Db(Mutex::new(conn)));
    Ok(())
}

/// 附件原件：id + MIME + base64 字节。字节走 base64，避免 JSON 数字数组的体积膨胀。
#[derive(Deserialize)]
pub struct DbFile {
    id: String,
    #[serde(default)]
    mime: String,
    data: String,
}

#[derive(Serialize)]
pub struct LoadedFile {
    mime: String,
    data: String,
}

/// 会话保存参数：data / summary 为前端序列化好的 JSON 文本；title 与 search_text 单列供搜索。
#[derive(Deserialize)]
pub struct SessionSave {
    #[serde(rename = "sessionId")]
    session_id: String,
    title: String,
    #[serde(rename = "createdAt")]
    created_at: i64,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
    data: String,
    summary: String,
    #[serde(rename = "searchText", default)]
    search_text: String,
    #[serde(default)]
    files: Vec<DbFile>,
}

#[derive(Serialize)]
pub struct SearchSnippet {
    text: String,
    offset: i64,
}

#[derive(Serialize)]
pub struct SearchHit {
    #[serde(rename = "sessionId")]
    session_id: String,
    title: String,
    #[serde(rename = "updatedAt")]
    updated_at: i64,
    count: i64,
    snippets: Vec<SearchSnippet>,
}

/// 大小写不敏感的子串搜索（ASCII 层折叠逐字节长度不变，位置可直接映射回原文）。
/// 返回命中次数与最多 limit 个片段，片段取匹配词前后各 64 字符。
fn collect_snippets(title: &str, body: &str, needle: &str, limit: usize) -> (i64, Vec<SearchSnippet>) {
    let hay_title = title.to_ascii_lowercase();
    let hay_body = body.to_ascii_lowercase();
    let needle = needle.to_ascii_lowercase();
    let mut count = 0i64;
    let mut snippets = Vec::new();
    count += hay_title.matches(&needle).count() as i64;
    // 字符索引表：把字节位置映射回原文的字符边界
    let indices: Vec<usize> = body.char_indices().map(|(offset, _)| offset).collect();
    let boundary = |index: usize| -> usize {
        indices.get(index).copied().unwrap_or_else(|| body.len())
    };
    let mut cursor = 0usize;
    while let Some(found) = hay_body[cursor..].find(&needle) {
        let start = cursor + found;
        count += 1;
        if snippets.len() < limit {
            // 在 ASCII 小写文本上数出字符序号，再映射回原文
            let lower_start = hay_body[..start].chars().count();
            let lower_end = hay_body[..start + needle.len()].chars().count();
            let from = lower_start.saturating_sub(64);
            let to = (lower_end + 64).min(indices.len());
            let text = body[boundary(from)..boundary(to)].trim().to_string();
            snippets.push(SearchSnippet { text, offset: boundary(from) as i64 });
        }
        cursor = start + needle.len().max(1);
        if cursor >= hay_body.len() {
            break;
        }
    }
    (count, snippets)
}

fn upsert_session(conn: &Connection, save: &SessionSave, staging: bool) -> Result<(), String> {
    if staging {
        conn.execute(
            "INSERT INTO sessions_staging (id, title, created_at, updated_at, data, summary, search_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET title=?2, created_at=?3, updated_at=?4, data=?5, summary=?6, search_text=?7",
            params![
                save.session_id,
                save.title,
                save.created_at,
                save.updated_at,
                save.data,
                save.summary,
                save.search_text
            ],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at, data) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET title=?2, created_at=?3, updated_at=?4, data=?5",
        params![save.session_id, save.title, save.created_at, save.updated_at, save.data],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO session_summaries (id, title, created_at, updated_at, summary) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET title=?2, created_at=?3, updated_at=?4, summary=?5",
        params![save.session_id, save.title, save.created_at, save.updated_at, save.summary],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO search_texts (session_id, title, body, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(session_id) DO UPDATE SET title=?2, body=?3, updated_at=?4",
        params![save.session_id, save.title, save.search_text, save.updated_at],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM file_refs WHERE session_id = ?1", params![save.session_id])
        .map_err(|e| e.to_string())?;
    let summary: serde_json::Value = serde_json::from_str(&save.summary).map_err(|e| e.to_string())?;
    if let Some(ids) = summary.get("fileIds").and_then(|v| v.as_array()) {
        for id in ids {
            if let Some(id) = id.as_str() {
                conn.execute(
                    "INSERT OR IGNORE INTO file_refs (session_id, file_id) VALUES (?1, ?2)",
                    params![save.session_id, id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn save_files(conn: &Connection, table: &str, files: &[DbFile]) -> Result<(), String> {
    for file in files {
        let bytes = B64.decode(&file.data).map_err(|e| e.to_string())?;
        conn.execute(
            &format!(
                "INSERT INTO {table} (id, mime, bytes) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET mime=?2, bytes=?3"
            ),
            params![file.id, file.mime, bytes],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 分页加载会话摘要：按 updated_at 倒序，分页下推到 SQL，与 IndexedDB 版语义一致。
#[tauri::command]
pub fn db_load_summaries_page(
    db: State<'_, Db>,
    limit: i64,
    before_updated_at: Option<i64>,
    before_id: Option<String>,
) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT summary FROM session_summaries
             WHERE (?1 IS NULL OR updated_at < ?1 OR (updated_at = ?1 AND id < ?2))
             ORDER BY updated_at DESC, id DESC
             LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![before_updated_at, before_id.unwrap_or_default(), limit],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 读取单个会话的完整 JSON
#[tauri::command]
pub fn db_load_session(db: State<'_, Db>, id: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT data FROM sessions WHERE id = ?1", params![id], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

/// 保存会话：整会话 JSON + 摘要 + 附件 + 搜索文本，一个事务
#[tauri::command]
pub fn db_save_session(db: State<'_, Db>, save: SessionSave) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    upsert_session(&tx, &save, false)?;
    save_files(&tx, "files", &save.files)?;
    tx.commit().map_err(|e| e.to_string())
}

/// 删除会话：同时清理搜索文本与不再被引用的附件
#[tauri::command]
pub fn db_delete_session(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let summary: Option<String> = conn
        .query_row(
            "SELECT summary FROM session_summaries WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sessions WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM session_summaries WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM search_texts WHERE session_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM file_refs WHERE session_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if let Some(summary) = summary {
        let value: serde_json::Value = serde_json::from_str(&summary).map_err(|e| e.to_string())?;
        if let Some(ids) = value.get("fileIds").and_then(|v| v.as_array()) {
            for id in ids {
                let Some(id) = id.as_str() else { continue };
                let refs: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM file_refs WHERE file_id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if refs == 0 {
                    tx.execute("DELETE FROM files WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
                    tx.execute("DELETE FROM file_texts WHERE id = ?1", params![id])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// 保存附件（新增附件时写入）
#[tauri::command]
pub fn db_save_files(db: State<'_, Db>, files: Vec<DbFile>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    save_files(&tx, "files", &files)?;
    tx.commit().map_err(|e| e.to_string())
}

/// 读取附件原件
#[tauri::command]
pub fn db_load_file(db: State<'_, Db>, id: String) -> Result<Option<LoadedFile>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT mime, bytes FROM files WHERE id = ?1", params![id], |row| {
        let mime: String = row.get(0)?;
        let bytes: Vec<u8> = row.get(1)?;
        Ok(LoadedFile { mime, data: B64.encode(bytes) })
    })
    .optional()
    .map_err(|e| e.to_string())
}

/// 保存一份 OCR 识别文本（doc 为前端序列化的 StoredFileText JSON）
#[tauri::command]
pub fn db_save_file_text(db: State<'_, Db>, id: String, doc: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO file_texts (id, doc) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET doc=?2",
        params![id, doc],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// 读取 OCR 识别文本
#[tauri::command]
pub fn db_load_file_text(db: State<'_, Db>, id: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT doc FROM file_texts WHERE id = ?1", params![id], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

/// 清空导入暂存
#[tauri::command]
pub fn db_clear_staging(db: State<'_, Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sessions_staging", []).map(|_| ()).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM files_staging", []).map(|_| ()).map_err(|e| e.to_string())
}

/// 暂存一条导入的会话（含摘要与搜索文本）
#[tauri::command]
pub fn db_add_staging_session(db: State<'_, Db>, save: SessionSave) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    upsert_session(&conn, &save, true)
}

/// 批量暂存导入的会话：一个事务写一批，避免逐条 IPC 与逐条事务的开销
#[tauri::command]
pub fn db_add_staging_sessions(db: State<'_, Db>, saves: Vec<SessionSave>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for save in &saves {
        upsert_session(&tx, save, true)?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// 批量暂存导入的附件
#[tauri::command]
pub fn db_save_staging_files(db: State<'_, Db>, files: Vec<DbFile>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    save_files(&tx, "files_staging", &files)?;
    tx.commit().map_err(|e| e.to_string())
}

/// 图片位于会话 JSON 之后，全部读完后回填 MIME 类型
#[tauri::command]
pub fn db_update_staging_file_types(
    db: State<'_, Db>,
    types: Vec<(String, String)>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let map: std::collections::HashMap<String, String> = types.into_iter().collect();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = {
        let mut stmt = tx
            .prepare("SELECT id, data FROM sessions_staging")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (id, data) in rows {
        let mut value: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        let mut changed = false;
        if let Some(messages) = value.get_mut("messages").and_then(|v| v.as_array_mut()) {
            for message in messages {
                if message.get("role").and_then(|v| v.as_str()) != Some("user") {
                    continue;
                }
                if let Some(files) = message.get_mut("files").and_then(|v| v.as_array_mut()) {
                    for file in files {
                        let file_id = file.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if let Some(mime) = map.get(&file_id) {
                            if file.get("mimeType").and_then(|v| v.as_str()) != Some(mime.as_str()) {
                                file["mimeType"] = serde_json::Value::String(mime.clone());
                                changed = true;
                            }
                        }
                    }
                }
            }
        }
        if changed {
            tx.execute(
                "UPDATE sessions_staging SET data = ?2 WHERE id = ?1",
                params![id, serde_json::to_string(&value).map_err(|e| e.to_string())?],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

/// 用暂存替换正式数据（一个事务）；返回全部会话的摘要 JSON 列表
#[tauri::command]
pub fn db_commit_staging(db: State<'_, Db>) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sessions", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM session_summaries", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM files", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM file_texts", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM file_refs", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM search_texts", []).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at, data)
         SELECT id, title, created_at, updated_at, data FROM sessions_staging",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO session_summaries (id, title, created_at, updated_at, summary)
         SELECT id, title, created_at, updated_at, summary FROM sessions_staging",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO files (id, mime, bytes) SELECT id, mime, bytes FROM files_staging",
        [],
    )
    .map_err(|e| e.to_string())?;
    // 重建搜索文本与附件引用
    let staged: Vec<(String, String, String, i64)> = {
        let mut stmt = tx
            .prepare("SELECT id, title, search_text, updated_at FROM sessions_staging")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (id, title, body, updated_at) in &staged {
        tx.execute(
            "INSERT OR IGNORE INTO search_texts (session_id, title, body, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, title, body, updated_at],
        )
        .map_err(|e| e.to_string())?;
    }
    let refs: Vec<(String, String)> = {
        let mut stmt = tx
            .prepare("SELECT id, summary FROM sessions_staging")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (session_id, summary) in &refs {
        let value: serde_json::Value = serde_json::from_str(summary).map_err(|e| e.to_string())?;
        if let Some(ids) = value.get("fileIds").and_then(|v| v.as_array()) {
            for id in ids {
                if let Some(id) = id.as_str() {
                    tx.execute(
                        "INSERT OR IGNORE INTO file_refs (session_id, file_id) VALUES (?1, ?2)",
                        params![session_id, id],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    tx.execute("DELETE FROM sessions_staging", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM files_staging", []).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(refs.into_iter().map(|(_, summary)| summary).collect())
}

/// 全对话内容搜索：读出全部搜索文本做大小写不敏感的子串匹配，按会话聚合。
/// title 与正文都参与匹配；正文命中数含标题命中。结果按会话最近更新时间倒序。
#[tauri::command]
pub fn db_search(db: State<'_, Db>, query: String) -> Result<Vec<SearchHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT session_id, title, body, updated_at FROM search_texts")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut hits: Vec<SearchHit> = rows
        .into_iter()
        .filter_map(|(session_id, title, body, updated_at)| {
            let (count, snippets) = collect_snippets(&title, &body, trimmed, 3);
            (count > 0).then_some(SearchHit {
                session_id,
                title,
                updated_at,
                count,
                snippets,
            })
        })
        .collect();
    hits.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(hits)
}
