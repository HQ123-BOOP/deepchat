import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.hq123boop.chatdemo',
  appName: 'chat-demo',
  webDir: 'dist',
  // Android 上以 https://localhost 提供页面，保持安全上下文（IndexedDB / 麦克风 / CORS）
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
  android: {
    allowMixedContent: false,
    // 主题色与页面背景一致，避免启动时的白屏闪烁
    backgroundColor: '#ffffff',
  },
}

export default config
