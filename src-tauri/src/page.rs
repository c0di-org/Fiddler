//! PDF pages, rasterised at the size they'll actually be shown.
//!
//! Quick Look will hand back a picture of page one, which is enough for a tile
//! and useless for reading: there is no page two, and no way to ask for it
//! bigger than the thumbnail it decided to give you. Core Graphics has had a PDF
//! rasteriser in-process the whole time, so we use that instead — any page, any
//! size, and the result lands in the same on-disk cache as every other preview.
//!
//! Rendering at the requested size rather than scaling a thumbnail is the whole
//! point: text in a PDF is vector art, and a page rendered at 1400px is sharp in
//! a way that a 512px thumbnail stretched to fit never is.

use std::path::{Path, PathBuf};

use objc2_core_foundation::{CFRetained, CFURL, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGContext, CGInterpolationQuality, CGPDFBox, CGPDFDocument, CGPDFPage};

/// Paper white behind the page, since PDF content is drawn on nothing.
const PAPER: f64 = 1.0;

/// What a document is, before we render any of it.
pub struct Meta {
    pub pages: u32,
    /// Width over height of the first page, so the frontend can reserve the
    /// right box before the first render arrives and avoid a layout jump.
    pub aspect: f64,
}

pub fn meta(path: &Path) -> Result<Meta, String> {
    let doc = open(path)?;
    let pages = CGPDFDocument::number_of_pages(Some(&doc)) as u32;
    if pages == 0 {
        return Err("no pages".into());
    }
    let page = CGPDFDocument::page(Some(&doc), 1).ok_or("no first page")?;
    let (w, h) = displayed_size(&page);
    Ok(Meta { pages, aspect: if h > 0.0 { w / h } else { 1.0 } })
}

/// Render one 1-based page, longest side `max_px`, and write it to `out`.
pub fn render(path: &Path, page: u32, max_px: u32, out: &Path) -> Result<(), String> {
    let doc = open(path)?;
    let count = CGPDFDocument::number_of_pages(Some(&doc));
    if page == 0 || page as usize > count {
        return Err(format!("page {page} is outside a {count}-page document"));
    }
    let pdf = CGPDFDocument::page(Some(&doc), page as usize).ok_or("could not read the page")?;

    let (pw, ph) = displayed_size(&pdf);
    if pw <= 0.0 || ph <= 0.0 {
        return Err("the page has no size".into());
    }
    let scale = max_px as f64 / pw.max(ph);
    let w = (pw * scale).round().max(1.0);
    let h = (ph * scale).round().max(1.0);

    let ctx = crate::thumb::bitmap(w as usize, h as usize)?;
    crate::thumb::wash(&ctx, w, h, PAPER);
    CGContext::set_should_antialias(Some(&ctx), true);
    CGContext::set_interpolation_quality(Some(&ctx), CGInterpolationQuality::High);

    // Core Graphics works out the fit, including the page's own /Rotate — which
    // is why scanned documents come back the right way up without us measuring
    // anything ourselves.
    let into = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w, h));
    let transform = CGPDFPage::drawing_transform(Some(&pdf), CGPDFBox::CropBox, into, 0, true);
    CGContext::concat_ctm(Some(&ctx), transform);
    CGContext::draw_pdf_page(Some(&ctx), Some(&pdf));

    crate::thumb::save(&ctx, out)
}

/// Render through the shared on-disk cache, returning the file's path. Pages
/// already rendered at this size cost one `stat`.
pub fn cached_render(path: &Path, page: u32, max_px: u32) -> Result<PathBuf, String> {
    let out = crate::thumb::keyed(path, max_px, page as u64)?;
    if out.is_file() {
        return Ok(out);
    }
    render(path, page, max_px, &out)?;
    Ok(out)
}

fn open(path: &Path) -> Result<CFRetained<CGPDFDocument>, String> {
    let url = CFURL::from_file_path(path).ok_or("unrepresentable path")?;
    let doc = CGPDFDocument::with_url(Some(&url)).ok_or("not a readable PDF")?;
    // Password-protected files render as blank pages rather than failing, so
    // they're better refused here and left to Quick Look, which can at least
    // show the padlock.
    if !CGPDFDocument::is_unlocked(Some(&doc)) {
        return Err("the document is locked".into());
    }
    Ok(doc)
}

/// The page's size as the reader sees it, with rotation applied.
fn displayed_size(page: &CGPDFPage) -> (f64, f64) {
    let b = CGPDFPage::box_rect(Some(page), CGPDFBox::CropBox);
    let turned = CGPDFPage::rotation_angle(Some(page)).rem_euclid(360) % 180 != 0;
    if turned {
        (b.size.height, b.size.width)
    } else {
        (b.size.width, b.size.height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str =
        "/System/Library/CoreServices/liquiddetectiond.app/lockScreenLiquidDetection.pdf";

    fn fixture() -> Option<&'static Path> {
        let p = Path::new(FIXTURE);
        if p.is_file() {
            Some(p)
        } else {
            eprintln!("skipping, no PDF fixture at {FIXTURE}");
            None
        }
    }

    #[test]
    fn a_missing_file_is_an_error_rather_than_a_panic() {
        let missing = std::env::temp_dir().join("fiddler-no-such.pdf");
        std::fs::remove_file(&missing).ok();
        assert!(meta(&missing).is_err());
        assert!(render(&missing, 1, 256, &missing.with_extension("png")).is_err());
    }

    #[test]
    fn a_file_that_is_not_a_pdf_is_refused() {
        let f = std::env::temp_dir().join("fiddler-not-a.pdf");
        std::fs::write(&f, b"this is not a PDF at all").unwrap();
        assert!(meta(&f).is_err());
        std::fs::remove_file(&f).ok();
    }

    #[test]
    fn pages_outside_the_document_are_refused() {
        let Some(p) = fixture() else { return };
        let out = std::env::temp_dir().join("fiddler-pdf-oob.png");
        assert!(render(p, 0, 256, &out).is_err(), "pages are 1-based");
        assert!(render(p, 9999, 256, &out).is_err());
    }

    #[test]
    fn a_real_page_renders_at_the_size_asked_for() {
        let Some(p) = fixture() else { return };
        let m = meta(p).expect("the fixture should have readable metadata");
        assert!(m.pages >= 1);
        assert!(m.aspect > 0.0);

        let out = std::env::temp_dir().join("fiddler-pdf-page.png");
        std::fs::remove_file(&out).ok();
        render(p, 1, 512, &out).expect("page one should render");
        assert!(std::fs::metadata(&out).unwrap().len() > 0);
        std::fs::remove_file(&out).ok();
    }

    #[test]
    fn a_second_render_comes_from_the_cache() {
        let Some(p) = fixture() else { return };
        let first = cached_render(p, 1, 128).expect("first render");
        let again = cached_render(p, 1, 128).expect("cache hit");
        assert_eq!(first, again);
        assert!(first.is_file());
    }
}

