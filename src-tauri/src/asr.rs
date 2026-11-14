//! 通过 CrispASR 的原生库（libcrispasr.so，Android 打包在 jniLibs 里）做离线语音识别。
//!
//! 走 dlopen + C ABI：Android 侧由 MainActivity 先 `System.loadLibrary("crispasr")`，
//! 依赖的 libggml*/libomp/libc++_shared 会被一并加载，这里按名字再次 dlopen 即可拿到句柄。

use std::ffi::{c_char, c_float, c_int, c_void, CStr, CString};
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

/// SenseVoice-Small Q4_K 权重地址（HuggingFace 直连在国内不可用，默认走镜像）
const MODEL_URL: &str =
    "https://hf-mirror.com/cstr/sensevoice-small-GGUF/resolve/main/sensevoice-small-q4_k.gguf";
/// 小于该体积视为未下载完成
const MODEL_MIN_BYTES: u64 = 120 * 1024 * 1024;

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

fn download_to(path: &std::path::Path) -> Result<(), String> {
    use std::io::{Read, Write};
    let tmp = path.with_extension("gguf.part");
    let mut response = reqwest::blocking::get(MODEL_URL)
        .map_err(|e| format!("下载失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败: {e}"))?;
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("无法创建临时文件: {e}"))?;
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = response.read(&mut buffer).map_err(|e| format!("下载中断: {e}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("写入失败: {e}"))?;
    }
    file.flush().map_err(|e| format!("写入失败: {e}"))?;
    drop(file);
    let size = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
    if size < MODEL_MIN_BYTES {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("下载的文件不完整（{size} 字节）"));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("保存模型失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn asr_download_model(app: tauri::AppHandle) -> Result<(), String> {
    let path = model_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || download_to(&path))
        .await
        .map_err(|e| format!("下载任务异常: {e}"))?
}
