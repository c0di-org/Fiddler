//! Bounded content search for the visible folder's already-listed text files.
//!
//! This is intentionally not a recursive index. The frontend supplies direct
//! child names after its instant name search settles, while these limits remain
//! enforced here for every caller.

use std::fs;
use std::io::Read;
use std::path::{Component, Path};

use serde::Serialize;

const MAX_FILES: usize = 512;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_HITS: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentHit {
    pub name: String,
    /// One-based source line containing the first requested term.
    pub line: u32,
    /// A compact, single-line preview that is safe to render in a result tile.
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearch {
    pub hits: Vec<ContentHit>,
    pub truncated: bool,
}

pub fn search(root: &Path, names: &[String], terms: &[String]) -> ContentSearch {
    if terms.is_empty() {
        return ContentSearch {
            hits: Vec::new(),
            truncated: false,
        };
    }

    let mut hits = Vec::new();
    let mut total_bytes = 0u64;
    let mut truncated = names.len() > MAX_FILES;

    for name in names.iter().take(MAX_FILES) {
        if hits.len() == MAX_HITS {
            truncated = true;
            break;
        }
        if !is_child_name(name) {
            continue;
        }

        let path = root.join(name);
        // `symlink_metadata` makes a file symlink a non-file here: content
        // search must not follow an alias outside the currently viewed folder.
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.file_type().is_file() || meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let remaining = MAX_TOTAL_BYTES.saturating_sub(total_bytes);
        if meta.len() > remaining {
            truncated = true;
            break;
        }
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        // The metadata check above avoids opening known-large files. `take`
        // keeps that promise true if a file grows between metadata and read.
        let limit = MAX_FILE_BYTES.min(remaining);
        let mut bytes = Vec::with_capacity(meta.len() as usize + 1);
        let Ok(_) = file.take(limit + 1).read_to_end(&mut bytes) else {
            continue;
        };
        if bytes.len() as u64 > limit {
            truncated = true;
            if limit < MAX_FILE_BYTES {
                break;
            }
            continue;
        }
        total_bytes += bytes.len() as u64;
        if bytes.contains(&0) {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let folded = text.to_lowercase();
        if !terms.iter().all(|term| folded.contains(term)) {
            continue;
        }

        let first = folded.find(&terms[0]).unwrap_or(0);
        let line = folded[..first]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count() as u32
            + 1;
        let snippet = text
            .lines()
            .nth(line.saturating_sub(1) as usize)
            .map(compact_snippet)
            .unwrap_or_default();
        hits.push(ContentHit {
            name: name.clone(),
            line,
            snippet,
        });
    }

    ContentSearch { hits, truncated }
}

fn is_child_name(name: &str) -> bool {
    matches!(
        Path::new(name).components().next(),
        Some(Component::Normal(_))
    ) && Path::new(name).components().count() == 1
}

fn compact_snippet(line: &str) -> String {
    let compact = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = compact.chars().take(140).collect();
    if compact.chars().count() > out.chars().count() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root(label: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("fiddler-content-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn finds_all_terms_and_returns_a_line_snippet() {
        let root = temp_root("terms");
        fs::write(
            root.join("notes.md"),
            "first line\nSearch engine design is fast\n",
        )
        .unwrap();
        fs::write(root.join("other.txt"), "search only").unwrap();
        let names = vec!["notes.md".into(), "other.txt".into()];

        let result = search(&root, &names, &["search".into(), "fast".into()]);
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].name, "notes.md");
        assert_eq!(result.hits[0].line, 2);
        assert_eq!(result.hits[0].snippet, "Search engine design is fast");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_names_that_escape_the_visible_folder() {
        let root = temp_root("scope");
        let result = search(&root, &["../outside.txt".into()], &["anything".into()]);
        assert!(result.hits.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
