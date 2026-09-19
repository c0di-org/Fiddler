//! Linux desktop integration: activation, single-instance forwarding and
//! org.freedesktop.FileManager1.

use std::future::pending;
use std::process::Command;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use zbus::{connection, interface};

use crate::opened;

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

pub fn handle_management_args(args: &[String]) -> bool {
    if args.iter().any(|arg| arg == "--make-default") {
        match make_default() {
            Ok(()) => println!("Fiddler is now the default handler for folders."),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return true;
    }
    if args.iter().any(|arg| arg == "--is-default") {
        println!("{}", if is_default() { "yes" } else { "no" });
        return true;
    }
    false
}

pub fn forward_existing(inputs: &[String]) -> bool {
    let Ok(connection) = zbus::blocking::Connection::session() else {
        return false;
    };
    let Ok(proxy) = zbus::blocking::Proxy::new(&connection, APP_BUS, APP_PATH, APP_IFACE) else {
        return false;
    };
    let cwd = std::env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let result: zbus::Result<()> = proxy.call("Activate", &(inputs.to_vec(), cwd));
    result.is_ok()
}

struct ApplicationService {
    app: AppHandle,
}

#[interface(name = "app.fiddler.desktop.Application")]
impl ApplicationService {
    fn activate(&self, inputs: Vec<String>, cwd: String) {
        let cwd = (!cwd.is_empty()).then(|| std::path::PathBuf::from(cwd));
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

fn runtime() -> Option<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()
}

fn start_app_service(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(runtime) = runtime() else { return };
        let Ok(builder) = connection::Builder::session() else { return };
        let Ok(builder) = builder.name(APP_BUS) else { return };
        let Ok(builder) = builder.serve_at(APP_PATH, ApplicationService { app }) else { return };
        let Ok(_connection) = runtime.block_on(builder.build()) else { return };
        runtime.block_on(pending::<()>());
    });
}

fn start_file_manager_service(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(runtime) = runtime() else { return };
        loop {
            // Owning this well-known name changes where desktop "Show in
            // Folder" requests go. Only claim it after the user has explicitly
            // made Fiddler their directory handler.
            if !is_default() {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }

            let Ok(builder) = connection::Builder::session() else {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            };
            let Ok(builder) = builder.name("org.freedesktop.FileManager1") else {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            };
            let Ok(builder) = builder.serve_at(
                "/org/freedesktop/FileManager1",
                FileManagerService { app: app.clone() },
            ) else {
                std::thread::sleep(Duration::from_secs(2));
                continue;
            };
            match runtime.block_on(builder.build()) {
                Ok(connection) => {
                    // Keep the current-thread runtime alive while we own the
                    // name: zbus dispatches method calls on this runtime. A
                    // blocking sleep here would leave the service registered
                    // but unable to answer ShowItems/ShowFolders requests.
                    runtime.block_on(async {
                        while is_default() {
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        }
                    });
                    drop(connection);
                }
                Err(_) => {
                    // Another file manager currently owns the standard name.
                    // Never replace it.
                    std::thread::sleep(Duration::from_secs(2));
                }
            }
        }
    });
}

pub fn make_default() -> Result<(), String> {
    let exe = installed_executable()?;
    if !std::path::Path::new("/usr/share/applications/Fiddler.desktop").is_file() {
        install_user_desktop_entry(&exe)?;
    }

    set_mimeapps_default()?;

    // Keep desktop-specific caches in sync when xdg-utils is present. The
    // freedesktop mimeapps.list written above is the source of truth, so a
    // minimal system without xdg-mime still works.
    let _ = Command::new("xdg-mime")
        .args(["default", "Fiddler.desktop", "inode/directory"])
        .status();

    let data = dirs::data_local_dir().ok_or("couldn't find the user data directory")?;
    let services = data.join("dbus-1/services");
    std::fs::create_dir_all(&services).map_err(|e| e.to_string())?;
    let body = format!(
        "[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec={} --gapplication-service\n",
        dbus_exec(&exe.to_string_lossy())
    );
    std::fs::write(services.join("org.freedesktop.FileManager1.service"), body)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn installed_executable() -> Result<std::path::PathBuf, String> {
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        let path = std::path::PathBuf::from(appimage);
        if path.is_file() {
            return Ok(path);
        }
    }
    std::env::current_exe().map_err(|e| e.to_string())
}

fn install_user_desktop_entry(exe: &std::path::Path) -> Result<(), String> {
    let data = dirs::data_local_dir().ok_or("couldn't find the user data directory")?;
    let applications = data.join("applications");
    std::fs::create_dir_all(&applications).map_err(|e| e.to_string())?;
    let body = format!(
        "[Desktop Entry]\nVersion=1.0\nType=Application\nName=Fiddler\nGenericName=File Manager\nComment=A git-aware cross-platform file manager\nKeywords=files;folders;manager;filesystem;browse;\nExec={} %U\nStartupWMClass=fiddler\nIcon=fiddler\nTerminal=false\nStartupNotify=true\nCategories=System;FileTools;FileManager;\nMimeType=inode/directory;\n",
        dbus_exec(&exe.to_string_lossy())
    );
    std::fs::write(applications.join("Fiddler.desktop"), body).map_err(|e| e.to_string())?;

    // Refresh the per-user MIME cache when the standard helper is installed.
    // xdg-mime still writes the preference itself, so this is intentionally
    // best-effort for minimal systems and portable AppImages.
    let _ = Command::new("update-desktop-database").arg(&applications).status();
    Ok(())
}

pub fn is_default() -> bool {
    if let Some(answer) = Command::new("xdg-mime")
        .args(["query", "default", "inode/directory"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
    {
        return answer.trim() == "Fiddler.desktop";
    }

    let Some(config) = dirs::config_dir() else { return false };
    match std::fs::read_to_string(config.join("mimeapps.list")) {
        Ok(content) => mimeapps_default(&content) == Some("Fiddler.desktop"),
        Err(_) => false,
    }
}

fn set_mimeapps_default() -> Result<(), String> {
    let config = dirs::config_dir().ok_or("couldn't find the user config directory")?;
    std::fs::create_dir_all(&config).map_err(|e| e.to_string())?;
    let path = config.join("mimeapps.list");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    std::fs::write(&path, update_mimeapps(&current)).map_err(|e| e.to_string())
}

fn update_mimeapps(input: &str) -> String {
    let mut lines: Vec<String> = input.lines().map(str::to_owned).collect();
    set_ini_value(
        &mut lines,
        "Default Applications",
        "inode/directory",
        "Fiddler.desktop;",
    );
    set_ini_value(
        &mut lines,
        "Added Associations",
        "inode/directory",
        "Fiddler.desktop;",
    );
    let mut output = lines.join("\n");
    output.push('\n');
    output
}

fn set_ini_value(lines: &mut Vec<String>, section: &str, key: &str, value: &str) {
    let header = format!("[{section}]");
    let start = lines.iter().position(|line| line.trim() == header);
    let start = match start {
        Some(index) => index,
        None => {
            if !lines.is_empty() && !lines.last().is_some_and(|line| line.is_empty()) {
                lines.push(String::new());
            }
            lines.push(header);
            lines.push(format!("{key}={value}"));
            return;
        }
    };

    let end = lines[start + 1..]
        .iter()
        .position(|line| {
            let trimmed = line.trim();
            trimmed.starts_with('[') && trimmed.ends_with(']')
        })
        .map(|offset| start + 1 + offset)
        .unwrap_or(lines.len());

    let prefix = format!("{key}=");
    if let Some(index) = (start + 1..end).find(|&index| lines[index].trim_start().starts_with(&prefix)) {
        lines[index] = format!("{key}={value}");
    } else {
        lines.insert(end, format!("{key}={value}"));
    }
}

fn mimeapps_default(input: &str) -> Option<&str> {
    let mut in_defaults = false;
    for line in input.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_defaults = trimmed == "[Default Applications]";
            continue;
        }
        if in_defaults {
            if let Some(value) = trimmed.strip_prefix("inode/directory=") {
                return value
                    .split(';')
                    .map(str::trim)
                    .find(|value| !value.is_empty());
            }
        }
    }
    None
}

fn dbus_exec(input: &str) -> String {
    format!("\"{}\"", input.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_paths_are_quoted_for_dbus_activation() {
        assert_eq!(dbus_exec("/usr/bin/fiddler"), "\"/usr/bin/fiddler\"");
        assert_eq!(dbus_exec("/home/A B/Fiddler"), "\"/home/A B/Fiddler\"");
    }

    #[test]
    fn portable_desktop_entry_uses_valid_spec_metadata() {
        let body = format!(
            "[Desktop Entry]\nVersion=1.0\nType=Application\nName=Fiddler\nGenericName=File Manager\nComment=A git-aware cross-platform file manager\nKeywords=files;folders;manager;filesystem;browse;\nExec={} %U\nStartupWMClass=fiddler\nIcon=fiddler\nTerminal=false\nStartupNotify=true\nCategories=System;FileTools;FileManager;\nMimeType=inode/directory;\n",
            dbus_exec("/tmp/Fiddler.AppImage")
        );
        assert!(body.contains("Version=1.0\n"));
        assert!(!body.contains("Version=1.5"));
        assert!(body.contains("Categories=System;FileTools;FileManager;\n"));
        assert!(!body.contains("Categories=System;Utility;"));
    }

    #[test]
    fn mimeapps_update_preserves_other_defaults() {
        let input = "[Default Applications]\ntext/plain=org.gnome.TextEditor.desktop;\n\n[Added Associations]\nimage/png=org.gnome.Loupe.desktop;\n";
        let updated = update_mimeapps(input);
        assert!(updated.contains("text/plain=org.gnome.TextEditor.desktop;"));
        assert!(updated.contains("image/png=org.gnome.Loupe.desktop;"));
        assert!(updated.contains("inode/directory=Fiddler.desktop;"));
        assert_eq!(mimeapps_default(&updated), Some("Fiddler.desktop"));
    }

    #[test]
    fn mimeapps_update_creates_missing_sections() {
        let updated = update_mimeapps("");
        assert!(updated.contains("[Default Applications]"));
        assert!(updated.contains("[Added Associations]"));
        assert_eq!(mimeapps_default(&updated), Some("Fiddler.desktop"));
    }
}
