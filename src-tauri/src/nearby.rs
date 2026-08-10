//! Bounded breadth-first search for the toolbar's zero-result fallback.
//!
//! This intentionally returns lightweight path metadata rather than a complete
//! directory listing. It never follows directory symlinks, is shallow by API
//! contract, and stops after a fixed amount of work. The frontend applies the
//! same ranking grammar used for local and (eventually) recent-file results.

use std::collections::VecDeque;
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::model::Kind;

/// Reading a large project root should not monopolise a worker thread.
const MAX_DIRS: usize = 2_000;
const MAX_ENTRIES: usize = 10_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyEntry {
    pub name: String,
    pub path: String,
    pub kind: Kind,
    pub link_to_dir: bool,
    pub hidden: bool,
    /// Path below the folder the user was searching from, for disambiguation.
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbySearch {
    pub entries: Vec<NearbyEntry>,
    pub truncated: bool,
}

pub fn scan(root: &Path, show_hidden: bool, max_depth: u8) -> Result<NearbySearch, String> {
    // Two levels is enough to find a misplaced source file from a project root
    // without quietly becoming a whole-disk index. Keep the ceiling server-side
    // so an older or malicious client cannot widen it.
    let max_depth = max_depth.clamp(1, 2);
    let mut queue = VecDeque::from([(root.to_path_buf(), 0u8)]);
    let mut entries = Vec::new();
    let mut examined = 0usize;
    let mut dirs = 0usize;
    let mut truncated = false;

    while let Some((dir, depth)) = queue.pop_front() {
        if dirs == MAX_DIRS || examined == MAX_ENTRIES {
            truncated = true;
            break;
        }
        dirs += 1;

        let Ok(read_dir) = fs::read_dir(&dir) else {
            // A fallback search should quietly skip a folder that disappeared or
            // is unreadable. The visible folder still surfaces its real error.
            continue;
        };

        for entry in read_dir.flatten() {
            if examined == MAX_ENTRIES {
                truncated = true;
                break;
            }
            examined += 1;

            let name = entry.file_name().to_string_lossy().into_owned();
            let hidden = name.starts_with('.');
            if name == ".DS_Store" || (!show_hidden && hidden) {
                continue;
            }

            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            let (kind, link_to_dir) = if file_type.is_symlink() {
                // Do not enqueue symlinks: a shallow root search must not escape
                // its root or cycle through an alias.
                (Kind::Symlink, path.is_dir())
            } else if file_type.is_dir() {
                (Kind::Dir, true)
            } else {
                (Kind::File, false)
            };

            let relative_path = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            entries.push(NearbyEntry {
                name: name.clone(),
                path: path.to_string_lossy().into_owned(),
                kind,
                link_to_dir,
                hidden,
                relative_path,
            });

            if depth + 1 < max_depth && file_type.is_dir() && !is_expensive_tree(&name) {
                queue.push_back((path, depth + 1));
            }
        }
    }

    Ok(NearbySearch { entries, truncated })
}

/// These folders are generated dependency or VCS trees. Skipping their descent
/// keeps a project-root fallback useful even when one is enormous.
fn is_expensive_tree(name: &str) -> bool {
    matches!(name, "node_modules" | ".git" | "target" | "dist" | "build")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("fiddler-nearby-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn searches_two_levels_but_not_three() {
        let root = temp_root("depth");
        fs::write(root.join("top.rs"), "").unwrap();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::write(root.join("src/one.rs"), "").unwrap();
        fs::write(root.join("src/deep/two.rs"), "").unwrap();

        let found = scan(&root, false, 2).unwrap();
        let names: Vec<_> = found
            .entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect();
        assert!(names.contains(&"top.rs"));
        assert!(names.contains(&"src/one.rs"));
        assert!(!names.contains(&"src/deep/two.rs"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hidden_folders_are_not_returned_or_descended_by_default() {
        let root = temp_root("hidden");
        fs::create_dir_all(root.join(".cache")).unwrap();
        fs::write(root.join(".cache/secret.txt"), "").unwrap();

        let found = scan(&root, false, 2).unwrap();
        assert!(found.entries.is_empty());

        fs::remove_dir_all(root).unwrap();
    }
}
