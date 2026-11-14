//! 通过 CrispASR 的原生库（libcrispasr.so，Android 打包在 jniLibs 里）做离线语音识别。
//!
//! 走 dlopen + C ABI：Android 侧由 MainActivity 先 `System.loadLibrary("crispasr")`，
//! 依赖的 libggml*/libomp/libc++_shared 会被一并加载，这里按名字再次 dlopen 即可拿到句柄。

use std::ffi::{c_char, c_float, c_int, c_void, CStr, CString};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use libloading::Library;

type SessionPtr = *mut c_void;
type ResultPtr = *mut c_void;

#[allow(dead_code)]
struct Api {
    _lib: Library,
    open: unsafe extern "C" fn(*const c_char, c_int) -> SessionPtr,
    close: unsafe extern "C" fn(SessionPtr),
    transcribe_lang:
        unsafe extern "C" fn(SessionPtr, *const c_float, c_int, *const c_char) -> ResultPtr,
    result_n_segments: unsafe extern "C" fn(ResultPtr) -> c_int,
    result_segment_text: unsafe extern "C" fn(ResultPtr, c_int) -> *const c_char,
    result_free: unsafe extern "C" fn(ResultPtr),
}

// libcrispasr 的客户端句柄不是 Send/Sync 类型，放在 Mutex 里顺序访问即可。
struct SessionHolder(SessionPtr);
unsafe impl Send for SessionHolder {}

static API: OnceLock<Result<Api, String>> = OnceLock::new();
static SESSION: Mutex<Option<SessionHolder>> = Mutex::new(None);

fn load_api() -> Result<&'static Api, String> {
    let cached = API.get_or_init(|| unsafe {
        let lib = Library::new("libcrispasr.so")
            .map_err(|e| format!("无法加载 libcrispasr.so: {e}"))?;
        let open = *lib
            .get::<unsafe extern "C" fn(*const c_char, c_int) -> SessionPtr>(
                b"crispasr_session_open\0",
            )
            .map_err(|e| format!("缺少符号 crispasr_session_open: {e}"))?;
        let close = *lib
            .get::<unsafe extern "C" fn(SessionPtr)>(b"crispasr_session_close\0")
            .map_err(|e| format!("缺少符号 crispasr_session_close: {e}"))?;
        let transcribe_lang = *lib
            .get::<unsafe extern "C" fn(SessionPtr, *const c_float, c_int, *const c_char) -> ResultPtr>(
                b"crispasr_session_transcribe_lang\0",
            )
            .map_err(|e| format!("缺少符号 crispasr_session_transcribe_lang: {e}"))?;
        let result_n_segments = *lib
            .get::<unsafe extern "C" fn(ResultPtr) -> c_int>(
                b"crispasr_session_result_n_segments\0",
            )
            .map_err(|e| format!("缺少符号 crispasr_session_result_n_segments: {e}"))?;
        let result_segment_text = *lib
            .get::<unsafe extern "C" fn(ResultPtr, c_int) -> *const c_char>(
                b"crispasr_session_result_segment_text\0",
            )
            .map_err(|e| format!("缺少符号 crispasr_session_result_segment_text: {e}"))?;
        let result_free = *lib
            .get::<unsafe extern "C" fn(ResultPtr)>(b"crispasr_session_result_free\0")
            .map_err(|e| format!("缺少符号 crispasr_session_result_free: {e}"))?;
        Ok(Api {
            _lib: lib,
            open,
            close,
            transcribe_lang,
            result_n_segments,
            result_segment_text,
            result_free,
        })
    });
    cached.as_ref().map_err(|e| e.clone())
}

fn open_session(model_path: &str, threads: u32) -> Result<SessionPtr, String> {
    let api = load_api()?;
    let path = CString::new(model_path).map_err(|e| e.to_string())?;
    let handle = unsafe { (api.open)(path.as_ptr(), threads as c_int) };
    if handle.is_null() {
        return Err(format!("打开模型失败：{model_path}"));
    }
    Ok(handle)
}

#[tauri::command]
pub fn asr_open(model_path: String, threads: Option<u32>) -> Result<(), String> {
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    if let Some(old) = slot.take() {
        if let Ok(api) = load_api() {
            unsafe { (api.close)(old.0) };
        }
    }
    let handle = open_session(&model_path, threads.unwrap_or(4))?;
    *slot = Some(SessionHolder(handle));
    Ok(())
}

#[tauri::command]
pub fn asr_transcribe(pcm: Vec<f32>, lang: Option<String>) -> Result<String, String> {
    let api = load_api()?;
    let slot = SESSION.lock().map_err(|e| e.to_string())?;
    let session = slot
        .as_ref()
        .ok_or_else(|| "语音识别模型尚未初始化".to_string())?
        .0;
    let lang = CString::new(lang.unwrap_or_else(|| "zh".to_string())).map_err(|e| e.to_string())?;
    let result = unsafe {
        (api.transcribe_lang)(session, pcm.as_ptr(), pcm.len() as c_int, lang.as_ptr())
    };
    if result.is_null() {
        return Err("转写失败".to_string());
    }
    let mut text = String::new();
    unsafe {
        let count = (api.result_n_segments)(result);
        for i in 0..count {
            let ptr = (api.result_segment_text)(result, i);
            if ptr.is_null() {
                continue;
            }
            text.push_str(&CStr::from_ptr(ptr).to_string_lossy());
        }
        (api.result_free)(result);
    }
    Ok(text)
}

#[tauri::command]
pub fn asr_close() -> Result<(), String> {
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    if let Some(holder) = slot.take() {
        if let Ok(api) = load_api() {
            unsafe { (api.close)(holder.0) };
        }
    }
    Ok(())
}

#[tauri::command]
pub fn asr_available() -> bool {
    load_api().is_ok()
}

/// SenseVoice-Small Q4_K 的下载源。三个源的文件不是同一份字节：
/// 只有 huggingface / hf-mirror 是带 CMVN 的当前版本，ModelScope 上那份是修复前的旧转换。
/// 每个源各自记录体积与 SHA-256，下载完成后按所属源校验。
struct ModelSource {
    name: &'static str,
    url: &'static str,
    size: u64,
    sha256: &'static str,
}

const MODEL_SOURCES: &[ModelSource] = &[
    ModelSource {
        name: "huggingface",
        url: "https://huggingface.co/cstr/sensevoice-small-GGUF/resolve/main/sensevoice-small-q4_k.gguf",
        size: 135_553_632,
        sha256: "8a41cfd32e6fd8f5ca330e2425e87bfbed128b42779b40dcc5d100040ec63cc9",
    },
    ModelSource {
        name: "hf-mirror",
        url: "https://hf-mirror.com/cstr/sensevoice-small-GGUF/resolve/main/sensevoice-small-q4_k.gguf",
        size: 135_553_632,
        sha256: "8a41cfd32e6fd8f5ca330e2425e87bfbed128b42779b40dcc5d100040ec63cc9",
    },
    ModelSource {
        name: "modelscope",
        url: "https://modelscope.cn/models/cloudlnk/sensevoice-small-GGUF/resolve/master/sensevoice-small-q4_k.gguf",
        size: 135_549_024,
        sha256: "b76123fcdf8dd447867446ad4fab3d071bec1cf327ec107829563346307e3891",
    },
];

/// 小于该体积视为未下载完成
const MODEL_MIN_BYTES: u64 = 120 * 1024 * 1024;

static DL_DONE: AtomicU64 = AtomicU64::new(0);
static DL_TOTAL: AtomicU64 = AtomicU64::new(0);
static DL_ACTIVE: AtomicBool = AtomicBool::new(false);

fn model_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录: {e}"))?;
    Ok(dir.join("model.gguf"))
}

#[tauri::command]
pub fn asr_model_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(model_file(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn asr_model_ready(app: tauri::AppHandle) -> bool {
    match model_file(&app) {
        Ok(path) => std::fs::metadata(&path)
            .map(|m| m.len() >= MODEL_MIN_BYTES)
            .unwrap_or(false),
        Err(_) => false,
    }
}

#[derive(serde::Serialize)]
pub struct DownloadProgress {
    downloaded: u64,
    total: u64,
    active: bool,
}

#[tauri::command]
pub fn asr_download_progress() -> DownloadProgress {
    DownloadProgress {
        downloaded: DL_DONE.load(Ordering::Relaxed),
        total: DL_TOTAL.load(Ordering::Relaxed),
        active: DL_ACTIVE.load(Ordering::Relaxed),
    }
}

/// 用一次很小的 Range 请求测首个响应字节的耗时，作为下载源的延迟。
fn probe_latency(source: &ModelSource) -> Option<std::time::Duration> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    let started = std::time::Instant::now();
    let mut response = client
        .get(source.url)
        .header(reqwest::header::RANGE, "bytes=0-1023")
        .send()
        .ok()?;
    if !response.status().is_success() && response.status().as_u16() != 206 {
        return None;
    }
    let mut buf = [0u8; 1];
    use std::io::Read;
    response.read_exact(&mut buf).ok()?;
    Some(started.elapsed())
}

/// 并发探测所有源的延迟，返回最快的一个；全部不可达时回退到第一个源。
fn pick_source() -> &'static ModelSource {
    let mut handles = Vec::new();
    for source in MODEL_SOURCES {
        handles.push(std::thread::spawn(move || (source, probe_latency(source))));
    }
    let mut best: Option<(&'static ModelSource, std::time::Duration)> = None;
    for handle in handles {
        if let Ok((source, Some(latency))) = handle.join() {
            println!("[asr] source {} latency {} ms", source.name, latency.as_millis());
            if best.map(|(_, current)| latency < current).unwrap_or(true) {
                best = Some((source, latency));
            }
        }
    }
    match best {
        Some((source, latency)) => {
            println!("[asr] picked {} ({} ms)", source.name, latency.as_millis());
            source
        }
        None => {
            println!("[asr] no source reachable, falling back to {}", MODEL_SOURCES[0].name);
            &MODEL_SOURCES[0]
        }
    }
}

fn hex_upper(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn sha256_of(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("无法读取下载文件: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|e| format!("读取失败: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_upper(&hasher.finalize()))
}

fn download_to(source: &ModelSource, path: &std::path::Path) -> Result<(), String> {
    use std::io::{Read, Write};
    let tmp = path.with_extension("gguf.part");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| format!("无法创建下载客户端: {e}"))?;
    let mut response = client
        .get(source.url)
        .send()
        .map_err(|e| format!("下载失败（{}）: {e}", source.name))?
        .error_for_status()
        .map_err(|e| format!("下载失败（{}）: {e}", source.name))?;
    DL_TOTAL.store(response.content_length().unwrap_or(source.size), Ordering::Relaxed);
    DL_DONE.store(0, Ordering::Relaxed);
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("无法创建临时文件: {e}"))?;
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = response.read(&mut buffer).map_err(|e| format!("下载中断: {e}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("写入失败: {e}"))?;
        DL_DONE.fetch_add(read as u64, Ordering::Relaxed);
    }
    file.flush().map_err(|e| format!("写入失败: {e}"))?;
    drop(file);

    let size = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if size != source.size {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("下载的文件不完整（{size} 字节，预期 {}）", source.size));
    }
    let digest = sha256_of(&tmp)?;
    if !digest.eq_ignore_ascii_case(source.sha256) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("校验失败（{}）", source.name));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("保存模型失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn asr_download_model(app: tauri::AppHandle) -> Result<String, String> {
    let path = model_file(&app)?;
    DL_ACTIVE.store(true, Ordering::Relaxed);
    DL_DONE.store(0, Ordering::Relaxed);
    DL_TOTAL.store(0, Ordering::Relaxed);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let source = pick_source();
        download_to(source, &path).map(|_| source.name.to_string())
    })
    .await
    .map_err(|e| format!("下载任务异常: {e}"))?;
    DL_ACTIVE.store(false, Ordering::Relaxed);
    result
}
