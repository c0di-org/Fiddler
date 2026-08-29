# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# The Kotlin that Rust reaches through JNI by name.
#
# `loadClass("app.fiddler.desktop.PdfPreview")` and then
# `call_static_method(.., "render", ..)` is a reference R8 cannot see, so it
# renames these methods to `a`, `b`, `c` and the call fails at run time. Nothing
# fails at build time: the release APK is produced and installed, and then a PDF
# has no preview and an APK won't install, with a `NoSuchMethodError` nobody is
# reading logcat for. Debug builds don't minify, which is exactly why this hides.
#
# `NativeBridge` and `OpenedFile` deliberately aren't here. Kotlin calls into
# them by symbol, so R8 follows the reference and renames both sides together;
# the JNI direction is native methods, which it already keeps.
#
# `includedescriptorclasses` keeps the parameter and return types nameable too,
# since the JNI signatures spell them out.
-keep,includedescriptorclasses class app.fiddler.desktop.ApkInstaller { *; }
-keep,includedescriptorclasses class app.fiddler.desktop.PdfPreview { *; }
-keep,includedescriptorclasses class app.fiddler.desktop.Playback { *; }
