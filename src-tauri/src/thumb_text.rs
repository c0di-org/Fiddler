//! Text files, drawn as a page.
//!
//! Finder gives `notes.txt` and `main.rs` the same grey document glyph, so a
//! folder of source reads as a wall of identical icons. Drawing the first few
//! dozen lines instead means a README, a JSON blob and a Rust module are told
//! apart at a glance, before any of them is read.
//!
//! Quick Look can render text too, but it costs tens of milliseconds and a trip
//! to another process. Core Text lays out the same page in-process in well under
//! a millisecond, which is what makes it affordable to do for every tile in a
//! folder of ten thousand files.
//!
//! The layout is deliberately specified in *columns*, not points: a 64px tile
//! and a 512px tile are then the same document at two zoom levels, rather than
//! two different-looking documents.

use std::io::Read;
use std::path::Path;

use objc2_core_foundation::{
    CFAttributedString, CFDictionary, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{CGColor, CGContext};
use objc2_core_text::{
    kCTFontAttributeName, kCTForegroundColorAttributeName, CTFont, CTFontUIFontType, CTLine,
};

/// US Letter. The proportion is what makes the tile read as "a document" even at
/// sizes where no individual glyph is legible.
const PAGE_RATIO: f64 = 0.773;

/// Enough to fill the tallest page we draw several times over, so we never lay
/// out more of a file than we can show.
const HEAD_BYTES: usize = 32 * 1024;

/// Monospace columns across the text area. Everything else is derived from this.
const COLUMNS: f64 = 44.0;

/// Menlo's advance width as a fraction of its point size.
const ADVANCE: f64 = 0.6;

/// Margin as a fraction of page width.
const MARGIN: f64 = 0.085;

/// Baseline-to-baseline distance as a multiple of the font size.
const LEADING: f64 = 1.45;

/// A single line is clipped to the page anyway; laying out more than this just
/// burns time, and minified files are one very long line.
const MAX_COLUMNS: usize = 200;

/// Draw the head of `path` as a page and write it to `out`.
pub fn render(path: &Path, max_px: u32, out: &Path) -> Result<(), String> {
    let head = read_head(path)?;
    let style = Dialect::of(path);

    let page_h = max_px as f64;
    let page_w = (page_h * PAGE_RATIO).round();
    let margin = (page_w * MARGIN).round();
    let font_size = ((page_w - margin * 2.0) / (COLUMNS * ADVANCE)).max(1.0);
    let leading = font_size * LEADING;
    let rows = (((page_h - margin * 2.0) / leading).floor() as usize).max(1);

    let lines = layout(&head, style, rows);
    if lines.is_empty() {
        return Err("nothing to draw".into());
    }

    let ctx = crate::thumb::bitmap(page_w as usize, page_h as usize)?;
    crate::thumb::wash(&ctx, page_w, page_h, PAPER);
    // Text that runs past the right margin is cut off at the edge of the page
    // rather than bleeding into it, which is what a real page does.
    CGContext::clip_to_rect(
        Some(&ctx),
        CGRect::new(
            CGPoint::new(margin, 0.0),
            CGSize::new(page_w - margin * 2.0, page_h),
        ),
    );
    CGContext::set_should_antialias(Some(&ctx), true);
    CGContext::set_allows_font_subpixel_positioning(Some(&ctx), true);

    let fonts = Fonts::new(style, font_size)?;
    // Core Graphics puts the origin at the bottom left, so we walk down the page
    // from a first baseline one line below the top margin.
    let mut baseline = page_h - margin - font_size;
    for line in &lines {
        if !line.text.is_empty() {
            draw(&ctx, line, &fonts, margin, baseline)?;
        }
        baseline -= leading;
    }

    crate::thumb::save(&ctx, out)
}

/// Paper white, a touch off pure so the page has an edge against a light window.
const PAPER: f64 = 0.99;
/// Body text: dark enough to read, soft enough not to look like a screenshot.
const INK: f64 = 0.18;
/// Comments, quotes, fences — present, but clearly the quieter layer.
const FAINT: f64 = 0.58;

fn read_head(path: &Path) -> Result<String, String> {
    // `take` + `read_to_end` rather than one `read`, which is allowed to come
    // back short and would leave us drawing half a page.
    let mut buf = Vec::with_capacity(HEAD_BYTES);
    let f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    f.take(HEAD_BYTES as u64)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;

    // The same test `git` and `grep` use. A file that claims to be text and
    // isn't falls back to Quick Look rather than drawing mojibake.
    if buf.contains(&0) {
        return Err("not text".into());
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    if text.trim().is_empty() {
        return Err("empty".into());
    }
    Ok(text)
}

/// How to read the lines we're about to draw. Only enough distinction to make
/// the page's *shape* right — this is a thumbnail, not an editor.
#[derive(Clone, Copy, PartialEq)]
enum Dialect {
    Markdown,
    Code,
    Plain,
}

impl Dialect {
    fn of(path: &Path) -> Self {
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "md" | "mdx" | "markdown" | "rst" => Dialect::Markdown,
            "txt" | "text" | "log" | "csv" | "tsv" | "srt" | "vtt" => Dialect::Plain,
            _ => Dialect::Code,
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Weight {
    Body,
    Strong,
    Quiet,
}

struct Row {
    text: String,
    weight: Weight,
}

/// Turn raw file text into the rows we'll draw.
fn layout(head: &str, dialect: Dialect, rows: usize) -> Vec<Row> {
    let mut out = Vec::with_capacity(rows);
    let mut fenced = false;
    // Blank lines above the first real content say nothing about the file.
    let mut started = false;

    for raw in head.lines() {
        if out.len() == rows {
            break;
        }
        let line = clean(raw);
        if !started && line.trim().is_empty() {
            continue;
        }
        started = true;

        let trimmed = line.trim_start();
        let row = match dialect {
            Dialect::Markdown => {
                if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                    fenced = !fenced;
                    Row {
                        text: line,
                        weight: Weight::Quiet,
                    }
                } else if fenced {
                    Row {
                        text: line,
                        weight: Weight::Quiet,
                    }
                } else if let Some(heading) = heading(trimmed) {
                    Row {
                        text: heading,
                        weight: Weight::Strong,
                    }
                } else if trimmed.starts_with('>') {
                    Row {
                        text: line,
                        weight: Weight::Quiet,
                    }
                } else {
                    Row {
                        text: bullet(&line),
                        weight: Weight::Body,
                    }
                }
            }
            Dialect::Code => {
                let quiet = is_comment(trimmed);
                Row {
                    text: line,
                    weight: if quiet { Weight::Quiet } else { Weight::Body },
                }
            }
            Dialect::Plain => Row {
                text: line,
                weight: Weight::Body,
            },
        };
        out.push(row);
    }
    out
}

/// `## Title` -> `Title`, and only for a real ATX heading.
fn heading(trimmed: &str) -> Option<String> {
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    if !rest.starts_with(' ') {
        return None;
    }
    Some(rest.trim_start().to_string())
}

/// List markers become the bullet a reader would expect to see.
fn bullet(line: &str) -> String {
    let indent = line.len() - line.trim_start().len();
    let trimmed = line.trim_start();
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = trimmed.strip_prefix(marker) {
            return format!("{}• {}", &line[..indent], rest);
        }
    }
    line.to_string()
}

fn is_comment(trimmed: &str) -> bool {
    ["//", "#", "--", "/*", "*", ";", "%"]
        .iter()
        .any(|m| trimmed.starts_with(m))
}

/// Tabs become spaces (Core Text has no tab stops to work with here), control
/// characters go, and the line is cut at a width no page could show anyway.
fn clean(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(MAX_COLUMNS));
    for c in raw.chars() {
        if out.chars().count() >= MAX_COLUMNS {
            break;
        }
        match c {
            '\t' => out.push_str("  "),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

/// The three faces a page is drawn in, built once per render.
struct Fonts {
    body: CFRetained<CTFont>,
    strong: CFRetained<CTFont>,
    ink: CFRetained<CGColor>,
    faint: CFRetained<CGColor>,
}

impl Fonts {
    fn new(dialect: Dialect, size: f64) -> Result<Self, String> {
        // Prose reads better in the system face; code has to be monospaced or
        // the indentation — the thing that makes it recognisable — collapses.
        let (body, strong) = if dialect == Dialect::Markdown {
            (
                ui_font(CTFontUIFontType::System, size),
                ui_font(CTFontUIFontType::EmphasizedSystem, size),
            )
        } else {
            (
                named_font("Menlo-Regular", size),
                named_font("Menlo-Bold", size),
            )
        };
        Ok(Fonts {
            body: body.ok_or("no body font")?,
            strong: strong.ok_or("no bold font")?,
            ink: CGColor::new_generic_gray(INK, 1.0),
            faint: CGColor::new_generic_gray(FAINT, 1.0),
        })
    }

    fn face(&self, weight: Weight) -> (&CTFont, &CGColor) {
        match weight {
            Weight::Strong => (&self.strong, &self.ink),
            Weight::Quiet => (&self.body, &self.faint),
            Weight::Body => (&self.body, &self.ink),
        }
    }
}

fn ui_font(kind: CTFontUIFontType, size: f64) -> Option<CFRetained<CTFont>> {
    unsafe { CTFont::new_ui_font_for_language(kind, size, None) }
}

fn named_font(name: &str, size: f64) -> Option<CFRetained<CTFont>> {
    Some(unsafe { CTFont::with_name(&CFString::from_str(name), size, std::ptr::null()) })
}

fn draw(ctx: &CGContext, row: &Row, fonts: &Fonts, x: f64, y: f64) -> Result<(), String> {
    let (font, color) = fonts.face(row.weight);
    let keys: [&CFString; 2] = unsafe { [kCTFontAttributeName, kCTForegroundColorAttributeName] };
    // Both are CF types; the cast is what lets them share one attribute
    // dictionary, which is how Core Text wants to be handed a run.
    let values: [&CFType; 2] = [
        unsafe { &*(font as *const CTFont as *const CFType) },
        unsafe { &*(color as *const CGColor as *const CFType) },
    ];
    let attrs = CFDictionary::from_slices(&keys, &values);

    let text = CFString::from_str(&row.text);
    let attributed = unsafe { CFAttributedString::new(None, Some(&text), Some(attrs.as_ref())) }
        .ok_or("could not build the run")?;
    let line = unsafe { CTLine::with_attributed_string(&attributed) };

    CGContext::set_text_position(Some(ctx), x, y);
    unsafe { line.draw(ctx) };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_headings_lose_their_hashes_and_gain_weight() {
        let rows = layout("# Title\n\nbody\n", Dialect::Markdown, 10);
        assert_eq!(rows[0].text, "Title");
        assert!(rows[0].weight == Weight::Strong);
        assert_eq!(rows[2].text, "body");
        assert!(rows[2].weight == Weight::Body);
    }

    #[test]
    fn a_hash_without_a_space_is_not_a_heading() {
        assert_eq!(heading("#hashtag"), None);
        assert_eq!(heading("####### too many"), None);
        assert_eq!(heading("## Real"), Some("Real".into()));
    }

    #[test]
    fn list_markers_become_bullets_and_keep_their_indent() {
        assert_eq!(bullet("- one"), "• one");
        assert_eq!(bullet("    * nested"), "    • nested");
        assert_eq!(bullet("not a list"), "not a list");
    }

    #[test]
    fn fenced_code_inside_markdown_reads_as_the_quiet_layer() {
        let rows = layout("text\n```\ncode\n```\nafter\n", Dialect::Markdown, 10);
        assert!(rows[0].weight == Weight::Body);
        assert!(
            rows[2].weight == Weight::Quiet,
            "the fenced line should be quiet"
        );
        assert!(rows[4].weight == Weight::Body, "the fence has closed again");
    }

    #[test]
    fn comments_are_the_quiet_layer_in_code() {
        let rows = layout("// why\nfn main() {}\n", Dialect::Code, 10);
        assert!(rows[0].weight == Weight::Quiet);
        assert!(rows[1].weight == Weight::Body);
    }

    #[test]
    fn leading_blank_lines_never_waste_the_page() {
        let rows = layout("\n\n\nfirst\n", Dialect::Plain, 10);
        assert_eq!(rows[0].text, "first");
    }

    #[test]
    fn only_as_many_rows_as_fit_are_laid_out() {
        let many = (0..500)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(layout(&many, Dialect::Plain, 12).len(), 12);
    }

    #[test]
    fn very_long_lines_are_cut_before_layout() {
        let wide = "x".repeat(50_000);
        assert_eq!(clean(&wide).chars().count(), MAX_COLUMNS);
    }

    #[test]
    fn tabs_and_control_characters_are_normalised() {
        assert_eq!(clean("\tif x:\r"), "  if x:");
    }

    #[test]
    fn dialects_follow_the_extension() {
        assert!(Dialect::of(Path::new("/a/README.md")) == Dialect::Markdown);
        assert!(Dialect::of(Path::new("/a/notes.txt")) == Dialect::Plain);
        assert!(Dialect::of(Path::new("/a/main.rs")) == Dialect::Code);
    }

    #[test]
    fn binary_content_is_refused_rather_than_drawn() {
        let f = std::env::temp_dir().join("fiddler-text-thumb-binary.txt");
        std::fs::write(&f, b"abc\0def").unwrap();
        assert!(read_head(&f).is_err());
        std::fs::write(&f, b"   \n\n").unwrap();
        assert!(read_head(&f).is_err(), "an empty file has no page to draw");
        std::fs::remove_file(&f).ok();
    }

    #[test]
    fn a_page_of_text_actually_renders() {
        let f = std::env::temp_dir().join("fiddler-text-thumb.md");
        std::fs::write(&f, "# Title\n\nSome body text.\n\n- one\n- two\n").unwrap();
        let out = std::env::temp_dir().join("fiddler-text-thumb-out.png");
        std::fs::remove_file(&out).ok();

        render(&f, 256, &out).expect("a markdown file should render");
        assert!(std::fs::metadata(&out).unwrap().len() > 0);

        std::fs::remove_file(&f).ok();
        std::fs::remove_file(&out).ok();
    }
}
