// 桌面端入口：Windows 下隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    chat_demo_lib::run()
}
