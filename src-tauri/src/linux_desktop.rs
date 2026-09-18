//! Linux desktop integration: activation, single-instance forwarding and
//! org.freedesktop.FileManager1.

use std::future::pending;
use std::path::Path;
use std::process::Command;

use tauri::{AppHandle, Manager};
use zbus::{connection, interface};

use crate::opened::{self, IncomingLocation};

const APP_BUS: &str = "app.fiddler.desktop";
const APP_PATH: &str = "/app/fiddler/desktop";
const APP_IFACE: &str = "app.fiddler.desktop.Application";

fn focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Forward a second invocation to the already-running Fiddler.
///
/// Returns true only when an existing instance accepted the activation.
pub fn forward_existing(inputs: &[String]) -> bool {
    let Ok(connection) = zbus::blocking::Connection::session() else {
        return false;
    };
    let Ok(proxy) = zbus::blocking::Proxy::new(&connection, APP_BUS, APP_PATH, APP_IFACE) else {
        return false;
    };
    proxy.call::<_, _, ()>("Activate", &(inputs.to_vec())).is_ok()
}

struct ApplicationService {
    app: AppHandle,
}

#[interface(name = "app.fiddler.desktop.Application")]
impl ApplicationService {
    fn activate(&self, inputs: Vec<String>) {
        let cwd = std::env::current_dir().ok();
        opened::push(opened::from_inputs(inputs, cwd.as_deref(), false));
        focus(&self.app);
    }
}

struct FileManagerService {
    app: AppHandle,
}

#[interface(name = "org.freedesktop.FileManager1")]
impl FileManagerService {
    fn show_folders(&self, uris: Vec<String>, _startup_id: String) {
        let found = opened::from_inputs(uris, None, false)
            .into_iter()
            .map(|mut location| {
                location.select = false;
                location.preview = false;
                location
            });
        opened::push(found);
        focus(&self.app);
    }

    fn show_items(&self, uris: Vec<String>, _startup_id: String) {
        let found = opened::from_inputs(uris, None, false)
            .into_iter()
            .map(|mut location| {
                location.select = true;
                location.preview = false;
                location
            });
        opened::push(found);
        focus(&self.app);
    }

    fn show_item_properties(&self, uris: Vec<String>, _startup_id: String) {
        let found = opened::from_inputs(uris, None, false)
            .into_iter()
            .map(|mut location| {
                location.select = true;
                location.preview = true;
                location
            });
        opened::push(found);
        focus(&self.app);
    }
}

pub fn start(app: AppHandle) {
    start_app_service(app.clone());
    start_file_manager_service(app);
}

fn start_app_service(app: AppHandle) {
    std::thread::spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
            return;
        };
        runtime.block_on(async move {
            let Ok(_connection) = connection::Builder::session()
                .and_then(|builder| builder.name(APP_BUS))
                .and_then(|builder| builder.serve_at(APP_PATH, ApplicationService { app }))
                .and_then(|builder| Ok(builder))
                .and_then(|builder| Ok(builder))
            else {
                return;
            };
            let Ok(_connection) = _connection.build().await else {
                return;
            };
            pending::<()>().await;
        });
    });
}

fn start_file_manager_service(app: AppHandle) {
    std::thread::spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
            return;
        };
        runtime.block_on(async move {
            let Ok(builder) = connection::Builder::session()
                .and_then(|builder| builder.name("org.freedesktop.FileManager1"))
                .and_then(|builder| builder.serve_at(
                    "/org/freedesktop/FileManager1",
                    FileManagerService { app },
                ))
            else {
                return;
            };
            let Ok(_connection) = builder.build().await else {
                // Another file manager owns the well-known name. Do not replace it.
                return;
            };
            pending::<()>().await;
        });
    });
}

/// Explicit opt-in for becoming the directory handler. This never runs at
/// install time; changing a user's default is their choice.
pub fn make_default() -> Result<(), String> {
    let status = Command::new("xdg-mime")
        .args(["default", "Fiddler.desktop", "inode/directory"])
        .status()
        .map_err(|e| format!("couldn't run xdg-mime: {e}"))?;
    if !status.success() {
        return Err(format!("xdg-mime exited with {status}"));
    }

    // A per-user activation file avoids installing a system-wide competing
    // FileManager1 service. D-Bus searches XDG_DATA_HOME before system data.
    let data = dirs::data_local_dir().ok_or("couldn't find the user data directory")?;
    let services = data.join("dbus-1/services");
    std::fs::create_dir_all(&services).map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let body = format!(
        "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec={} --gapplication-service\n",
        shell_word(&exe.to_string_lossy())
    );
    std::fs::write(services.join("org.freedesktop.FileManager1.service"), body)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn is_default() -> bool {
    Command::new("xdg-mime")
        .args(["query", "default", "inode/directory"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .is_some_and(|answer| answer.trim() == "Fiddler.desktop")
}

fn shell_word(input: &str) -> String {
    if input.bytes().all(|b| b.is_ascii_alphanumeric() || b"/._-+".contains(&b)) {
        input.to_string()
    } else {
        format!("'{}'", input.replace('\\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_executable_paths_need_no_quotes() {
        assert_eq!(shell_word("/usr/bin/fiddler"), "/usr/bin/fiddler");
    }
}
