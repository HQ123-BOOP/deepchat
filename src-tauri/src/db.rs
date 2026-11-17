//! SQLite 主存储：会话、附件、识别文本与全文搜索。
//!
//! 所有数据原本在 WebView 的 IndexedDB 里，Rust 无法直接访问；迁移到 SQLite 后，
//! 搜索直接在 Rust 侧做（类似 ripgrep：全表读出 + 大小写不敏感的子串匹配）。
//! 会话本体以 JSON 文本整存整取，与前端「整会话保存」的写模式一致。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct Db {
    conn: Mutex<Connection>,
    /// 会话分块写入的临时缓冲：会话 JSON 可能达到数 MB，不能一次塞进 IPC。
    writes: Mutex<HashMap<String, String>>,
    path: PathBuf,
    /// 打开失败的库文件：不为 None 时 conn 指向内存中的临时空库，等待用户重建。
    corrupt: Mutex<Option<String>>,
}

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
-- 模型在应用内工作区生成或修改的文本文件；按会话隔离，不触碰系统文件
CREATE TABLE IF NOT EXISTS workspace_files (
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, path)
);
CREATE INDEX IF NOT EXISTS idx_summaries_updated ON session_summaries (updated_at DESC, id DESC);
";

fn open_connection(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    // 会话与附件都要可靠落盘：进程被系统杀掉时 NORMAL 会丢最近事务。
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

/// 数据库能否正常读取：损坏的库会让 quick_check 返回错误行。
fn is_healthy(conn: &Connection) -> bool {
    conn.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map(|value| value == "ok")
        .unwrap_or(false)
}

/// 损坏期间改用内存库：不读写磁盘，应用不会在启动阶段崩溃，也不覆盖原文件。
fn memory_connection() -> Result<Connection, String> {
    let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn init(app: &tauri::App) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("chat.sqlite3");
    let (conn, corrupt) = match open_connection(&path) {
        Ok(conn) if is_healthy(&conn) => (conn, None),
        Ok(conn) => {
            drop(conn);
            (memory_connection()?, Some(path.display().to_string()))
        }
        Err(_) => (memory_connection()?, Some(path.display().to_string())),
    };
    app.manage(Db {
        conn: Mutex::new(conn),
        writes: Mutex::new(HashMap::new()),
        path,
        corrupt: Mutex::new(corrupt),
    });
    Ok(())
}

#[derive(Serialize)]
pub struct DbHealth {
    corrupt: bool,
    path: String,
}

/// 前端启动时查询数据库状态，损坏则弹出恢复对话框。
#[tauri::command]
pub fn db_health(db: State<'_, Db>) -> Result<DbHealth, String> {
    let corrupt = db.corrupt.lock().map_err(|e| e.to_string())?;
    Ok(DbHealth {
        corrupt: corrupt.is_some(),
        path: db.path.display().to_string(),
    })
}

/// 重试打开损坏的库；成功则换回磁盘上的真实连接。
#[tauri::command]
pub fn db_retry(db: State<'_, Db>) -> Result<bool, String> {
    let mut corrupt = db.corrupt.lock().map_err(|e| e.to_string())?;
    if corrupt.is_none() {
        return Ok(true);
    }
    let Ok(conn) = open_connection(&db.path) else {
        return Ok(false);
    };
    if !is_healthy(&conn) {
        return Ok(false);
    }
    *db.conn.lock().map_err(|e| e.to_string())? = conn;
    db.writes.lock().map_err(|e| e.to_string())?.clear();
    *corrupt = None;
    Ok(true)
}

/// 备份路径：优先 `chat.sqlite3.bak`，已存在时加时间戳，避免覆盖上一次备份。
fn backup_path(path: &Path) -> PathBuf {
    let candidate = PathBuf::from(format!("{}.bak", path.display()));
    if !candidate.exists() {
        return candidate;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    PathBuf::from(format!("{}.{}.bak", path.display(), stamp))
}

/// 把损坏的库改名备份（含 WAL/SHM），再创建一个空库并换上新连接。旧文件不删除。
#[tauri::command]
pub fn db_rebuild(db: State<'_, Db>) -> Result<String, String> {
    let mut corrupt = db.corrupt.lock().map_err(|e| e.to_string())?;
    if corrupt.is_none() {
        return Err("database is healthy".to_string());
    }
    let backup = backup_path(&db.path);
    if db.path.exists() {
        std::fs::rename(&db.path, &backup).map_err(|e| e.to_string())?;
        for suffix in ["-wal", "-shm"] {
            let from = PathBuf::from(format!("{}{}", db.path.display(), suffix));
            if from.exists() {
                std::fs::rename(&from, format!("{}{}", backup.display(), suffix))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    let conn = open_connection(&db.path)?;
    *db.conn.lock().map_err(|e| e.to_string())? = conn;
    db.writes.lock().map_err(|e| e.to_string())?.clear();
    *corrupt = None;
    Ok(backup.display().to_string())
}

/// 数据目录所在磁盘的可用字节数：导入前据此判断空间是否足够。
#[tauri::command]
pub fn db_free_space(db: State<'_, Db>) -> Result<u64, String> {
    let dir = db
        .path
        .parent()
        .ok_or_else(|| "database path has no parent".to_string())?;
    fs2::available_space(dir).map_err(|e| e.to_string())
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

/// 会话保存参数：data 为前端序列化的会话 JSON；搜索文本在 Rust 侧从 JSON 提取，
/// 避免把大段文本再走一次 IPC。
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
    #[serde(default)]
    files: Vec<DbFile>,
}

/// 从会话 JSON 提取搜索文本：标题、用户提问、助手正文与思考、工具调用的查询词与网址。
/// 与旧前端逻辑一致，只保留前 8M 字符，避免异常长会话把库撑大。
fn extract_search_text(data: &str, title: &str) -> String {
    const MAX_CHARS: usize = 8 * 1024 * 1024;
    let mut parts: Vec<String> = vec![title.to_string()];
    let mut size = title.len();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
        if let Some(messages) = value.get("messages").and_then(|v| v.as_array()) {
            'messages: for message in messages {
                let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role == "user" {
                    if let Some(text) = message.get("content").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            parts.push(text.to_string());
                            size += text.len();
                        }
                    }
                    continue;
                }
                if role != "assistant" {
                    continue;
                }
                let Some(blocks) = message.get("blocks").and_then(|v| v.as_array()) else {
                    continue;
                };
                for block in blocks {
                    match block.get("type").and_then(|v| v.as_str()) {
                        Some("text") => {
                            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                parts.push(text.to_string());
                                size += text.len();
                            }
                        }
                        Some("thinking") => {
                            if let Some(text) = block.get("thinking").and_then(|v| v.as_str()) {
                                parts.push(text.to_string());
                                size += text.len();
                            }
                        }
                        Some("server_tool_use") => {
                            let Some(input) = block.get("input") else { continue };
                            if let Some(queries) = input.get("queries").and_then(|v| v.as_array()) {
                                for query in queries {
                                    if let Some(query) = query.as_str() {
                                        parts.push(query.to_string());
                                        size += query.len();
                                    }
                                }
                            }
                            if let Some(url) = input.get("url").and_then(|v| v.as_str()) {
                                parts.push(url.to_string());
                                size += url.len();
                            }
                            if let Some(pattern) = input.get("pattern").and_then(|v| v.as_str()) {
                                parts.push(pattern.to_string());
                                size += pattern.len();
                            }
                        }
                        _ => {}
                    }
                    if size > MAX_CHARS {
                        break 'messages;
                    }
                }
            }
        }
    }
    parts.join(" ")
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
    let search_text = extract_search_text(&save.data, &save.title);
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
                search_text
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
        params![save.session_id, save.title, search_text, save.updated_at],
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
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
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
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT data FROM sessions WHERE id = ?1", params![id], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

/// 保存会话：整会话 JSON + 摘要 + 附件 + 搜索文本，一个事务
#[tauri::command]
pub fn db_save_session(db: State<'_, Db>, save: SessionSave) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    upsert_session(&tx, &save, false)?;
    save_files(&tx, "files", &save.files)?;
    tx.commit().map_err(|e| e.to_string())
}

/// 开启一次分块会话写入。会话 JSON 可能有数 MB，Android 的 IPC 不适合一次传输。
#[tauri::command]
pub fn db_session_write_begin(db: State<'_, Db>, id: String) -> Result<(), String> {
    db.writes
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, String::new());
    Ok(())
}

/// 追加分块内容（每块建议不超过 256K 字符）
#[tauri::command]
pub fn db_session_write_chunk(db: State<'_, Db>, id: String, chunk: String) -> Result<(), String> {
    let mut writes = db.writes.lock().map_err(|e| e.to_string())?;
    let buffer = writes
        .get_mut(&id)
        .ok_or_else(|| "session write buffer is not open".to_string())?;
    buffer.push_str(&chunk);
    Ok(())
}

/// 提交分块写入：用缓冲内容替换 data，一个事务写会话、摘要和附件
#[tauri::command]
pub fn db_session_write_commit(db: State<'_, Db>, save: SessionSave) -> Result<(), String> {
    let data = db
        .writes
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&save.session_id)
        .ok_or_else(|| "session write buffer is missing".to_string())?;
    let save = SessionSave { data, ..save };
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    upsert_session(&tx, &save, false)?;
    save_files(&tx, "files", &save.files)?;
    tx.commit().map_err(|e| e.to_string())
}

/// 会话 JSON 的字符长度（用于分块读取）；不存在时返回 null。
/// 用 UTF-16 码元计数，与 JS 字符串下标一致（emoji 会占两个码元）。
#[tauri::command]
pub fn db_load_session_len(db: State<'_, Db>, id: String) -> Result<Option<usize>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let data: Option<String> = conn
        .query_row("SELECT data FROM sessions WHERE id = ?1", params![id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(data.map(|value| value.encode_utf16().count()))
}

/// 按 UTF-16 码元偏移读取会话 JSON 的一块，边界对齐到完整字符。
#[tauri::command]
pub fn db_load_session_chunk(
    db: State<'_, Db>,
    id: String,
    offset: usize,
    len: usize,
) -> Result<String, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let data: Option<String> = conn
        .query_row("SELECT data FROM sessions WHERE id = ?1", params![id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let data = data.ok_or_else(|| "session not found".to_string())?;
    Ok(utf16_chunk(&data, offset, len))
}

fn utf16_chunk(text: &str, offset: usize, max_len: usize) -> String {
    let end_limit = offset + max_len;
    let mut units = 0usize;
    let mut start: Option<usize> = None;
    let mut end = text.len();
    for (index, ch) in text.char_indices() {
        let width = ch.len_utf16();
        if start.is_none() && units >= offset {
            start = Some(index);
        }
        if start.is_some() && units + width > end_limit {
            end = index;
            break;
        }
        units += width;
    }
    match start {
        Some(start) if start <= end => text[start..end].to_string(),
        _ => String::new(),
    }
}

/// 删除会话：同时清理搜索文本与不再被引用的附件
#[tauri::command]
pub fn db_delete_session(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
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
    tx.execute("DELETE FROM workspace_files WHERE session_id = ?1", params![id])
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
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    save_files(&tx, "files", &files)?;
    tx.commit().map_err(|e| e.to_string())
}

/// 读取附件原件
#[tauri::command]
pub fn db_load_file(db: State<'_, Db>, id: String) -> Result<Option<LoadedFile>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
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
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
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
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT doc FROM file_texts WHERE id = ?1", params![id], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

/// 清空导入暂存
#[tauri::command]
pub fn db_clear_staging(db: State<'_, Db>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sessions_staging", []).map(|_| ()).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM files_staging", []).map(|_| ()).map_err(|e| e.to_string())
}

/// 暂存一条导入的会话（含摘要与搜索文本）
#[tauri::command]
pub fn db_add_staging_session(db: State<'_, Db>, save: SessionSave) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    upsert_session(&conn, &save, true)
}

/// 批量暂存导入的会话：一个事务写一批，避免逐条 IPC 与逐条事务的开销
#[tauri::command]
pub fn db_add_staging_sessions(db: State<'_, Db>, saves: Vec<SessionSave>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for save in &saves {
        upsert_session(&tx, save, true)?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// 导入期间把同步级别降到 NORMAL：暂存数据丢了重导即可，换来每批写入不再 fsync
#[tauri::command]
pub fn db_import_mode(db: State<'_, Db>, active: bool) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.pragma_update(None, "synchronous", if active { "NORMAL" } else { "FULL" })
        .map_err(|e| e.to_string())
}

/// 批量暂存导入的附件
#[tauri::command]
pub fn db_save_staging_files(db: State<'_, Db>, files: Vec<DbFile>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
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
    if types.is_empty() {
        return Ok(());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
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
        // 没有图片的会话不需要解析整段 JSON
        if !data.contains("\"isImage\":true") {
            continue;
        }
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionVersion {
    id: String,
    updated_at: i64,
}

/// 全部会话的更新时间：导入前用它跳过本地已是最新的会话，避免无谓解压
#[tauri::command]
pub fn db_session_versions(db: State<'_, Db>) -> Result<Vec<SessionVersion>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, updated_at FROM sessions")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SessionVersion {
                id: row.get(0)?,
                updated_at: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 会话摘要里引用的附件 id
fn summary_file_ids(summary: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(summary) else {
        return Vec::new();
    };
    value
        .get("fileIds")
        .and_then(|v| v.as_array())
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// 会话被覆盖后回收不再被任何会话引用的附件原件与识别文本
fn reclaim_files(tx: &rusqlite::Transaction<'_>, ids: &[String]) -> Result<(), String> {
    for id in ids {
        let refs: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM file_refs WHERE file_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if refs == 0 {
            tx.execute("DELETE FROM files WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM file_texts WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct MergeResult {
    /// 实际写入的会话数（新增 + 覆盖较新的旧版本）
    imported: usize,
    /// 合并后的全部会话摘要
    summaries: Vec<String>,
}

/// 把暂存会话合并进正式数据：按 id 比对 updated_at，导入版本更新才覆盖，其余跳过。
#[tauri::command]
pub fn db_merge_staging(db: State<'_, Db>) -> Result<MergeResult, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let staged: Vec<(String, String, i64, i64, String, String, String)> = {
        let mut stmt = tx
            .prepare(
                "SELECT id, title, created_at, updated_at, data, summary, search_text
                 FROM sessions_staging",
            )
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let mut imported = 0usize;
    for (id, title, created_at, updated_at, data, summary, search_text) in &staged {
        let existing: Option<i64> = tx
            .query_row(
                "SELECT updated_at FROM sessions WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let mut previous_files: Vec<String> = Vec::new();
        if let Some(existing) = existing {
            // 本地同样新或更新时保留本地版本
            if *updated_at <= existing {
                continue;
            }
            if let Some(previous) = tx
                .query_row(
                    "SELECT summary FROM session_summaries WHERE id = ?1",
                    params![id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
            {
                previous_files = summary_file_ids(&previous);
            }
            tx.execute("DELETE FROM file_refs WHERE session_id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at, data)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, created_at = excluded.created_at,
               updated_at = excluded.updated_at, data = excluded.data",
            params![id, title, created_at, updated_at, data],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO session_summaries (id, title, created_at, updated_at, summary)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, created_at = excluded.created_at,
               updated_at = excluded.updated_at, summary = excluded.summary",
            params![id, title, created_at, updated_at, summary],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO search_texts (session_id, title, body, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, body = excluded.body,
               updated_at = excluded.updated_at",
            params![id, title, search_text, updated_at],
        )
        .map_err(|e| e.to_string())?;
        // 新附件只从暂存带到正式表，已有原件不覆盖
        let new_files = summary_file_ids(summary);
        for file_id in &new_files {
            tx.execute(
                "INSERT OR IGNORE INTO files (id, mime, bytes)
                 SELECT id, mime, bytes FROM files_staging WHERE id = ?1",
                params![file_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR IGNORE INTO file_refs (session_id, file_id) VALUES (?1, ?2)",
                params![id, file_id],
            )
            .map_err(|e| e.to_string())?;
        }
        // 旧版本独有、且已无人引用的附件在这里回收
        let obsolete: Vec<String> = previous_files
            .into_iter()
            .filter(|file| !new_files.contains(file))
            .collect();
        reclaim_files(&tx, &obsolete)?;
        imported += 1;
    }
    tx.execute("DELETE FROM sessions_staging", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM files_staging", [])
        .map_err(|e| e.to_string())?;
    let summaries: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT summary FROM session_summaries ORDER BY updated_at DESC, id DESC")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MergeResult { imported, summaries })
}

/// 用暂存替换正式数据（一个事务）；返回全部会话的摘要 JSON 列表
#[tauri::command]
pub fn db_commit_staging(db: State<'_, Db>) -> Result<Vec<String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sessions", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM session_summaries", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM files", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM file_texts", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM file_refs", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM search_texts", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM workspace_files", []).map_err(|e| e.to_string())?;
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
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
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

/// 单个会话内模型可写的文本工作区；上限按 UTF-8 字节计
const WORKSPACE_MAX_BYTES: usize = 512 * 1024;

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

/// 归一化模型给出的工作区相对路径：只允许应用内路径，拒绝绝对路径、`..` 与控制字符。
fn workspace_path(raw: &str) -> Result<String, String> {
    if raw.contains('\0') {
        return Err("file_path contains an invalid character".to_string());
    }
    let normalized = raw.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err("file_path must stay inside the app workspace".to_string());
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err("file_path must stay inside the app workspace".to_string()),
            _ => parts.push(part),
        }
    }
    let path = parts.join("/");
    if path.is_empty() {
        return Err("file_path must be a non-empty string".to_string());
    }
    if path.len() > 512 {
        return Err("file_path is too long".to_string());
    }
    Ok(path)
}

#[derive(Serialize)]
pub struct WorkspaceEntry {
    path: String,
    size: i64,
    updated_at: i64,
}

/// 列出会话工作区里的全部文件，最近修改的在前
#[tauri::command]
pub fn ws_list(db: State<'_, Db>, session_id: String) -> Result<Vec<WorkspaceEntry>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT path, length(content), updated_at FROM workspace_files
             WHERE session_id = ?1
             ORDER BY updated_at DESC, path",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(WorkspaceEntry {
                path: row.get(0)?,
                size: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 读取工作区文件；不存在时返回 null
#[tauri::command]
pub fn ws_read(
    db: State<'_, Db>,
    session_id: String,
    path: String,
) -> Result<Option<String>, String> {
    let path = workspace_path(&path)?;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT content FROM workspace_files WHERE session_id = ?1 AND path = ?2",
        params![session_id, path],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// 重名时追加 (1)、(2)…，避免覆盖用户已经下载的文件
fn unique_download_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..1000 {
        let file = match extension {
            Some(ext) => format!("{stem} ({index}).{ext}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = dir.join(file);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(name)
}

/// 把工作区文件写到系统下载目录；返回实际保存路径
#[tauri::command]
pub fn ws_export(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let path = workspace_path(&path)?;
    let content = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT content FROM workspace_files WHERE session_id = ?1 AND path = ?2",
            params![session_id, path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "file not found".to_string())?
    };
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = Path::new(&path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file.txt");
    let target = unique_download_path(&dir, name);
    std::fs::write(&target, content).map_err(|e| e.to_string())?;
    Ok(target.display().to_string())
}

/// 行级增删统计：先裁掉首尾相同的行，中间部分按新旧行数计入
fn line_diff_stats(before: &str, after: &str) -> (usize, usize) {
    let old: Vec<&str> = before.lines().collect();
    let new: Vec<&str> = after.lines().collect();
    let mut start = 0;
    while start < old.len() && start < new.len() && old[start] == new[start] {
        start += 1;
    }
    let mut old_end = old.len();
    let mut new_end = new.len();
    while old_end > start && new_end > start && old[old_end - 1] == new[new_end - 1] {
        old_end -= 1;
        new_end -= 1;
    }
    (new_end - start, old_end - start)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteStats {
    operation: String,
    added: i64,
    removed: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditStats {
    added: i64,
    removed: i64,
}

/// 新建或整体覆盖工作区文件，返回 create / update 与行级增删数
#[tauri::command]
pub fn ws_write(
    db: State<'_, Db>,
    session_id: String,
    path: String,
    content: String,
) -> Result<WriteStats, String> {
    let path = workspace_path(&path)?;
    if content.len() > WORKSPACE_MAX_BYTES {
        return Err(format!("file content exceeds {WORKSPACE_MAX_BYTES} bytes"));
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let previous: Option<String> = conn
        .query_row(
            "SELECT content FROM workspace_files WHERE session_id = ?1 AND path = ?2",
            params![session_id, path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (added, removed) = match &previous {
        Some(before) => line_diff_stats(before, &content),
        None => (content.lines().count(), 0),
    };
    let now = now_millis();
    conn.execute(
        "INSERT INTO workspace_files (session_id, path, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(session_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
        params![session_id, path, content, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(WriteStats {
        operation: if previous.is_some() { "update" } else { "create" }.to_string(),
        added: added as i64,
        removed: removed as i64,
    })
}

/// 按字面量替换工作区文件中的文本；replace_all 为 false 时要求唯一匹配
#[tauri::command]
pub fn ws_edit(
    db: State<'_, Db>,
    session_id: String,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: bool,
) -> Result<EditStats, String> {
    let path = workspace_path(&path)?;
    if old_string.is_empty() {
        return Err("old_string must be a non-empty string".to_string());
    }
    if old_string == new_string {
        return Err("old_string and new_string must differ".to_string());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let content: Option<String> = conn
        .query_row(
            "SELECT content FROM workspace_files WHERE session_id = ?1 AND path = ?2",
            params![session_id, path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(content) = content else {
        return Err(format!("file not found: {path}"));
    };
    let matches = content.matches(old_string.as_str()).count();
    if matches == 0 {
        return Err(format!("old_string was not found in {path}"));
    }
    // 多处匹配时必须显式要求全量替换，避免模型改错位置
    if matches > 1 && !replace_all {
        return Err(format!(
            "old_string appears {matches} times in {path}; add more context or set replace_all to true"
        ));
    }
    let updated = if replace_all {
        content.replace(old_string.as_str(), new_string.as_str())
    } else {
        content.replacen(old_string.as_str(), new_string.as_str(), 1)
    };
    if updated.len() > WORKSPACE_MAX_BYTES {
        return Err(format!("file content exceeds {WORKSPACE_MAX_BYTES} bytes"));
    }
    let (added, removed) = line_diff_stats(&content, &updated);
    conn.execute(
        "UPDATE workspace_files SET content = ?3, updated_at = ?4
         WHERE session_id = ?1 AND path = ?2",
        params![session_id, path, updated, now_millis()],
    )
    .map_err(|e| e.to_string())?;
    Ok(EditStats {
        added: added as i64,
        removed: removed as i64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 分块必须能无损拼回原文，且不切开代理对
    #[test]
    fn utf16_chunks_roundtrip() {
        let text = "{\"title\":\"你好😀世界𠮷\",\"text\":\"emoji 🚀 and ascii\"}".repeat(200);
        let total = text.encode_utf16().count();
        let mut rebuilt = String::new();
        let mut offset = 0usize;
        while offset < total {
            let chunk = utf16_chunk(&text, offset, 997);
            assert!(!chunk.is_empty());
            rebuilt.push_str(&chunk);
            offset += chunk.encode_utf16().count();
        }
        assert_eq!(rebuilt, text);
    }

    /// 会话写入后按分块读取应得到完整 JSON
    #[test]
    fn session_chunked_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let data = "{\"id\":\"s1\",\"title\":\"测试😀\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}";
        let save = SessionSave {
            session_id: "s1".into(),
            title: "测试😀".into(),
            created_at: 1,
            updated_at: 2,
            data: data.into(),
            summary: "{\"id\":\"s1\",\"fileIds\":[]}".into(),
            files: Vec::new(),
        };
        upsert_session(&conn, &save, false).unwrap();

        let stored: String = conn
            .query_row("SELECT data FROM sessions WHERE id='s1'", [], |row| row.get(0))
            .unwrap();
        let total = stored.encode_utf16().count();
        let mut rebuilt = String::new();
        let mut offset = 0usize;
        while offset < total {
            let chunk = utf16_chunk(&stored, offset, 11);
            rebuilt.push_str(&chunk);
            offset += chunk.encode_utf16().count();
        }
        assert_eq!(rebuilt, data);

        // 搜索文本由 Rust 从会话 JSON 提取
        let body: String = conn
            .query_row("SELECT body FROM search_texts WHERE session_id='s1'", [], |row| row.get(0))
            .unwrap();
        assert!(body.contains("你好"));
    }
}
