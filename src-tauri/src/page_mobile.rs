//! Android PDF pages use the platform PdfRenderer, reached through a tiny JNI
//! bridge. It rasterises only the requested page and stores it in the app cache,
//! so a page already seen is one `stat` rather than a second decode.

use std::path::{Path, PathBuf};

pub struct Meta {
    pub pages: u32,
    pub aspect: f64,
}

#[cfg(target_os = "android")]
pub fn meta(_path: &Path) -> Result<Meta, String> {
    let values = call_meta(_path)?;
    let pages = values[0] as u32;
    let aspect = values[1];
    if pages == 0 || !aspect.is_finite() || aspect <= 0.0 {
        return Err("the PDF has no readable pages".into());
    }
    Ok(Meta { pages, aspect })
}

#[cfg(not(target_os = "android"))]
pub fn meta(_path: &Path) -> Result<Meta, String> {
    Err("PDF previews are only available on macOS and Android".into())
}

#[cfg(target_os = "android")]
pub fn cached_render(path: &Path, page: u32, max_px: u32) -> Result<PathBuf, String> {
    if page == 0 {
        return Err("PDF pages start at 1".into());
    }
    let path = call_render(path, page, max_px)?;
    Ok(PathBuf::from(path))
}

#[cfg(not(target_os = "android"))]
pub fn cached_render(_path: &Path, _page: u32, _max_px: u32) -> Result<PathBuf, String> {
    Err("PDF previews are only available on macOS and Android".into())
}

#[cfg(target_os = "android")]
use crate::android_jni::with_env;

#[cfg(target_os = "android")]
fn preview_class<'a>(env: &mut jni::JNIEnv<'a>) -> Result<jni::objects::JClass<'a>, String> {
    crate::android_jni::class(env, "app.fiddler.desktop.PdfPreview")
}

#[cfg(target_os = "android")]
fn call_meta(path: &Path) -> Result<[f64; 2], String> {
    use jni::objects::{JObject, JValue};

    with_env(|env| {
        let class = preview_class(env)?;
        let path = env
            .new_string(path.to_string_lossy().as_ref())
            .map_err(|e| format!("couldn't encode PDF path: {e}"))?;
        let path = JObject::from(path);
        let result = env
            .call_static_method(
                class,
                "meta",
                "(Ljava/lang/String;)[D",
                &[JValue::Object(&path)],
            )
            .and_then(|v| v.l())
            .map_err(|e| format!("couldn't inspect PDF: {e}"))?;
        if result.is_null() {
            return Err("not a readable PDF".into());
        }
        let array = jni::objects::JDoubleArray::from(result);
        let mut values = [0.0; 2];
        env.get_double_array_region(&array, 0, &mut values)
            .map_err(|e| format!("couldn't read PDF metadata: {e}"))?;
        Ok(values)
    })
}

#[cfg(target_os = "android")]
fn call_render(path: &Path, page: u32, max_px: u32) -> Result<String, String> {
    use jni::objects::{JObject, JString, JValue};

    with_env(|env| {
        let class = preview_class(env)?;
        let context = crate::android_jni::context()?;
        let path = env
            .new_string(path.to_string_lossy().as_ref())
            .map_err(|e| format!("couldn't encode PDF path: {e}"))?;
        let path = JObject::from(path);
        let result = env
            .call_static_method(
                class,
                "render",
                "(Landroid/content/Context;Ljava/lang/String;II)Ljava/lang/String;",
                &[
                    JValue::Object(context.as_obj()),
                    JValue::Object(&path),
                    JValue::Int(page as i32),
                    JValue::Int(max_px as i32),
                ],
            )
            .and_then(|v| v.l())
            .map_err(|e| format!("couldn't render PDF: {e}"))?;
        if result.is_null() {
            return Err("this PDF couldn't be rendered".into());
        }
        let result = JString::from(result);
        let result: String = env
            .get_string(&result)
            .map_err(|e| format!("couldn't read PDF preview path: {e}"))?
            .into();
        Ok(result)
    })
}
