package com.hq123boop.chatdemo

import android.Manifest
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.util.Size
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    // 离线 ASR：把 CrispASR 及其依赖（libggml*/libomp/libc++_shared）加载进进程，
    // Rust 侧随后用 dlopen 按名字取符号。
    System.loadLibrary("crispasr")
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // edge-to-edge 下 WebView 会画到状态栏和手势条底下：给根视图补上系统栏内边距，
    // 顶部避让与官方 App 一致，否则页面最上面的内容会和状态栏重叠。
    val root = findViewById<View>(android.R.id.content)
    // 内边距暴露的是根视图自己的背景；主题默认色和页面底色并不相同（浅色设备上偏紫），
    // 所以直接用与页面一致的 window_background 资源铺满，日间 #FFFFFF、夜间 #151517。
    root.setBackgroundColor(ContextCompat.getColor(this, R.color.window_background))
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webViewRef = webView
    // 前端切换深浅色时通过这个桥同步状态栏、导航栏与根视图底色
    webView.addJavascriptInterface(ThemeBridge(), "AndroidTheme")
    // 最近照片与外部链接：在原生侧读取相册，避免 WebView 跳转后丢失页面状态
    webView.addJavascriptInterface(MediaBridge(), "AndroidMedia")
  }

  private fun mediaPermission(): String =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      Manifest.permission.READ_MEDIA_IMAGES
    } else {
      Manifest.permission.READ_EXTERNAL_STORAGE
    }

  /** Android 14 的「选择部分照片」只授予 VISUAL_USER_SELECTED，也算可读 */
  private fun hasMediaAccess(): Boolean =
    ContextCompat.checkSelfPermission(this, mediaPermission()) == PackageManager.PERMISSION_GRANTED ||
      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
        ContextCompat.checkSelfPermission(
          this,
          Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
        ) == PackageManager.PERMISSION_GRANTED)

  private fun loadPhotoBitmap(uri: Uri, size: Int): Bitmap? =
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        contentResolver.loadThumbnail(uri, Size(size, size), null)
      } else {
        @Suppress("DEPRECATION")
        MediaStore.Images.Thumbnails.getThumbnail(
          contentResolver,
          ContentUris.parseId(uri),
          MediaStore.Images.Thumbnails.MINI_KIND,
          null
        )
      }
    } catch (_: Exception) {
      null
    }

  private fun bitmapToDataUrl(bitmap: Bitmap, quality: Int): String {
    val stream = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.JPEG, quality, stream)
    return "data:image/jpeg;base64," +
      Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
  }

  private fun postJs(script: String) {
    webViewRef?.post { webViewRef?.evaluateJavascript(script, null) }
  }

  /** 桥只对应用自身页面开放，避免外部网页借 WebView 读取相册或拉起 Intent */
  private fun isAppPage(): Boolean {
    val url = webViewRef?.url ?: return false
    return url.startsWith("https://tauri.localhost") ||
      url.startsWith("http://tauri.localhost") ||
      url.startsWith("http://localhost") ||
      url.startsWith("http://127.0.0.1")
  }

  private fun postRecentPhotos(json: String) {
    postJs("window.__androidRecentPhotos && window.__androidRecentPhotos(${JSONObject.quote(json)})")
  }

  private fun queryRecentPhotos(limit: Int) {
    thread {
      val photos = JSONArray()
      val collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
      try {
        val projection = arrayOf(
          MediaStore.Images.Media._ID,
          MediaStore.Images.Media.DISPLAY_NAME
        )
        contentResolver.query(
          collection,
          projection,
          null,
          null,
          "${MediaStore.Images.Media.DATE_ADDED} DESC"
        )?.use { cursor ->
          val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
          val nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
          while (cursor.moveToNext() && photos.length() < limit) {
            val uri = ContentUris.withAppendedId(collection, cursor.getLong(idColumn))
            val bitmap = loadPhotoBitmap(uri, 320) ?: continue
            photos.put(
              JSONObject()
                .put("id", uri.toString())
                .put("name", cursor.getString(nameColumn) ?: "photo.jpg")
                .put("thumb", bitmapToDataUrl(bitmap, 72))
            )
            bitmap.recycle()
          }
        }
      } catch (_: Exception) {
        // 权限被撤销或媒体库不可用时返回已读到的部分
      }
      postRecentPhotos(photos.toString())
    }
  }

  inner class MediaBridge {
    @JavascriptInterface
    fun listRecentPhotos(limit: Int) {
      if (!isAppPage()) {
        postRecentPhotos("[]")
        return
      }
      val max = limit.coerceIn(1, 50)
      if (hasMediaAccess()) {
        queryRecentPhotos(max)
        return
      }
      runOnUiThread {
        requestPermissions(arrayOf(mediaPermission())) {
          if (hasMediaAccess()) {
            queryRecentPhotos(max)
          } else {
            postRecentPhotos("[]")
          }
        }
      }
    }

    @JavascriptInterface
    fun readPhoto(id: String) {
      if (!isAppPage()) {
        postJs(
          "window.__androidPhotoData && window.__androidPhotoData(" +
            "${JSONObject.quote(id)}, \"\")"
        )
        return
      }
      thread {
        var dataUrl = ""
        try {
          val bitmap = loadPhotoBitmap(Uri.parse(id), 2048)
          if (bitmap != null) {
            dataUrl = bitmapToDataUrl(bitmap, 88)
            bitmap.recycle()
          }
        } catch (_: Exception) {
          // 读取失败时回传空串，前端提示选择失败
        }
        postJs(
          "window.__androidPhotoData && window.__androidPhotoData(" +
            "${JSONObject.quote(id)}, ${JSONObject.quote(dataUrl)})"
        )
      }
    }

    @JavascriptInterface
    fun openExternal(url: String) {
      if (!isAppPage()) {
        return
      }
      runOnUiThread {
        try {
          startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: Exception) {
          // 没有可处理该链接的应用时忽略
        }
      }
    }
  }

  inner class ThemeBridge {
    @JavascriptInterface
    fun setTheme(dark: Boolean, color: String) {
      runOnUiThread {
        val backgroundColor = try {
          Color.parseColor(color)
        } catch (_: IllegalArgumentException) {
          ContextCompat.getColor(this@MainActivity, R.color.window_background)
        }
        // Android 15 起 statusBarColor 不再生效，状态栏区域实际显示的是根视图的 padding 背景
        findViewById<View>(android.R.id.content).setBackgroundColor(backgroundColor)
        @Suppress("DEPRECATION")
        window.statusBarColor = backgroundColor
        @Suppress("DEPRECATION")
        window.navigationBarColor = backgroundColor
        WindowCompat.getInsetsController(window, window.decorView).apply {
          isAppearanceLightStatusBars = !dark
          isAppearanceLightNavigationBars = !dark
        }
      }
    }
  }
}
