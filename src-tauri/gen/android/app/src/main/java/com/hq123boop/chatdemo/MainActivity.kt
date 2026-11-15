package com.hq123boop.chatdemo

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 离线 ASR：把 CrispASR 及其依赖（libggml*/libomp/libc++_shared）加载进进程，
    // Rust 侧随后用 dlopen 按名字取符号。
    System.loadLibrary("crispasr")
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // edge-to-edge 下 WebView 会画到状态栏和手势条底下：给根视图补上系统栏内边距，
    // 顶部避让与官方 App 一致，否则页面最上面的内容会和状态栏重叠。
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
  }
}
