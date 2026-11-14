package com.hq123boop.chatdemo

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 离线 ASR：把 CrispASR 及其依赖（libggml*/libomp/libc++_shared）加载进进程，
    // Rust 侧随后用 dlopen 按名字取符号。
    System.loadLibrary("crispasr")
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
