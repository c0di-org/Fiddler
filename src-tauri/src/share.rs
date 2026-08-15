//! Hand files to the system's share sheet.
//!
//! Every platform Fiddler runs on has one universal verb for "send this
//! somewhere else", and none of them is a file operation: Android's chooser,
//! macOS's `NSSharingServicePicker`. Both take a list of files and give back
//! nothing — the sheet is modal to the user, not to us, and where the file ends
//! up is not Fiddler's business.
//!
//! Folders are dropped rather than refused, on both. A selection of six files
//! and one folder is a clear request to send the six, and neither platform has
//! a concept of sharing a directory to fail at.

use tauri::AppHandle;

/// Raise the share sheet for these paths.
pub use imp::share;

#[cfg(target_os = "android")]
mod imp {
    use jni::objects::{JObject, JObjectArray, JString, JValue};

    use super::AppHandle;

    pub fn share(_app: &AppHandle, paths: &[String]) -> Result<(), String> {
        if paths.is_empty() {
            return Err("nothing to share".into());
        }
        crate::android_jni::with_env(|env| {
            let share = crate::android_jni::class(env, "app.fiddler.desktop.Share")?;
            let context = crate::android_jni::context()?;

            let empty = env
                .new_string("")
                .map_err(|e| format!("couldn't reach Java's string table: {e}"))?;
            let array: JObjectArray = env
                .new_object_array(paths.len() as i32, "java/lang/String", &empty)
                .map_err(|e| format!("couldn't build the path list: {e}"))?;
            for (at, path) in paths.iter().enumerate() {
                let item = env
                    .new_string(path)
                    .map_err(|e| format!("couldn't encode {path}: {e}"))?;
                env.set_object_array_element(&array, at as i32, &item)
                    .map_err(|e| format!("couldn't place {path} in the list: {e}"))?;
            }

            let result = env
                .call_static_method(
                    share,
                    "share",
                    "(Landroid/content/Context;[Ljava/lang/String;)Ljava/lang/String;",
                    &[
                        JValue::Object(context.as_obj()),
                        JValue::Object(&JObject::from(array)),
                    ],
                )
                .and_then(|v| v.l())
                .map_err(|e| format!("couldn't open the share sheet: {e}"))?;

            if result.is_null() {
                return Ok(());
            }
            let message: String = env
                .get_string(&JString::from(result))
                .map_err(|e| format!("couldn't read the share sheet's response: {e}"))?
                .into();
            Err(message)
        })
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::Path;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSSize, NSString, NSURL};
    use tauri::Manager;

    use super::AppHandle;

    /// Which edge of the anchor the sheet points away from. `NSMinYEdge` is 1,
    /// and on a window whose origin is bottom-left that is the bottom of the
    /// anchor — so the popover hangs downward, the way every menu here does.
    const NS_MIN_Y_EDGE: u64 = 1;

    pub fn share(app: &AppHandle, paths: &[String]) -> Result<(), String> {
        let files: Vec<String> = paths
            .iter()
            .filter(|path| Path::new(path).is_file())
            .cloned()
            .collect();
        if files.is_empty() {
            return Err("There's nothing here macOS can share — folders can't be sent, only files.".into());
        }

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Fiddler has no window to hang the share sheet on".to_string())?;

        // AppKit is main-thread-only and a command runs on a worker, so the
        // window handle is fetched on the far side rather than carried across:
        // an `NSWindow` pointer is not `Send`, and the `WebviewWindow` that can
        // produce one is. Nothing is waited for — the picker is shown and the
        // call returns, because where the file ends up is between the user and
        // the service they pick.
        app.run_on_main_thread(move || {
            let Ok(ns_window) = window.ns_window() else {
                return;
            };
            let ns_window = ns_window as *mut AnyObject;
            if ns_window.is_null() {
                return;
            }
            unsafe { present(ns_window, &files) }
        })
        .map_err(|e| format!("couldn't reach the main thread: {e}"))
    }

    /// # Safety
    /// Runs on the main thread with a live `NSWindow`. Every object below is
    /// either retained by `objc2` or borrowed for the length of one message.
    unsafe fn present(ns_window: *mut AnyObject, files: &[String]) {
        let urls: Vec<Retained<NSURL>> = files
            .iter()
            .map(|path| NSURL::fileURLWithPath(&NSString::from_str(path)))
            .collect();
        let items = NSArray::from_retained_slice(&urls);

        let picker: *mut AnyObject = msg_send![class!(NSSharingServicePicker), alloc];
        let picker: *mut AnyObject = msg_send![picker, initWithItems: &*items];
        if picker.is_null() {
            return;
        }
        let view: *mut AnyObject = msg_send![ns_window, contentView];
        if view.is_null() {
            return;
        }

        // Anchored to the top-left of the content view rather than to whatever
        // was clicked. The click that started this is in the webview, which has
        // no AppKit rect to hand back — and a sheet that always appears in the
        // same corner is easier to aim at than one that appears where the
        // pointer happened to be. The 1×1 rect is what AppKit uses for "here".
        let bounds: NSRect = msg_send![view, bounds];
        let anchor = NSRect::new(
            NSPoint::new(bounds.origin.x + 20.0, bounds.origin.y + bounds.size.height - 20.0),
            NSSize::new(1.0, 1.0),
        );
        let _: () = msg_send![picker, showRelativeToRect: anchor, ofView: view, preferredEdge: NS_MIN_Y_EDGE];
    }
}

#[cfg(not(any(target_os = "android", target_os = "macos")))]
mod imp {
    use super::AppHandle;

    pub fn share(_app: &AppHandle, _paths: &[String]) -> Result<(), String> {
        Err("Sharing is not available on this platform".into())
    }
}
