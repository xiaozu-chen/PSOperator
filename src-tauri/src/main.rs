// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Debug builds have a console subsystem. The elevated GUI child should not
    // expose that console as a second window, so detach only the admin relaunch.
    #[cfg(windows)]
    if std::env::args().any(|arg| arg == "--psoperator-admin-cwd") {
        unsafe {
            FreeConsole();
        }
    }
    psoperator_lib::run()
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn FreeConsole() -> i32;
}
