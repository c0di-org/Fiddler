<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" alt="Fiddler app icon">

# Fiddler

Cross-platform file management for macOS, Android/DeX, and the web.

**[Try the web app](https://files.c0di.com)**

<img src="docs/hero.png" width="880" alt="Fiddler browsing source files with the preview pane open">

</div>

## Features

- **Icon and list views** with sorting, expandable folders, breadcrumbs, hidden files, favorites, and type-to-jump navigation.
- **File operations** including new folders and text files, rename, copy, cut, paste, duplicate, internal drag and drop, delete/trash, and multi-select.
- **Undo** for rename, paste, drag/move, and recoverable trash operations.
- **Transfer progress and cancel** for longer copies and cross-volume moves, with rollback on cancel or failure.
- **Quick Look** for folders, images, audio, video, Markdown, source/text files, links, and PDFs.
- **PDF reader** with single-page or spread layout, fit-to-page/width, keyboard/touch navigation, full screen, and remembered reading position.
- **Text editing** inside Fiddler. On desktop, Open uses the system handler when one exists and falls back to the editor when it does not.
- **Search** across names and paths, plus content search for text files. Filters include forms such as `ext:ts` and `kind:dir`.
- **Git-aware browsing** with branch names, status dots, ignored-file state, and linked worktrees on desktop.
- **Nearby devices** on macOS and Android. Pair before browsing, then manage or revoke saved access later.
- **Android over USB** on macOS using MTP, including thumbnails for media on the device.
- **Mounted volumes** in the sidebar, including eject support where the platform allows it.
- **Platform sharing and file handoff** on native builds, including Android share/open-with handling and APK installation.
- **Session restore** for the last local folder and view preferences.
- **Keyboard and touch support** across desktop, DeX, phone, and browser layouts.

## Git worktrees

Fiddler discovers linked worktrees and shows them with the repository they belong to, even when the worktree lives outside the main repository folder.

<div align="center">
<img src="docs/worktrees.png" width="820" alt="Fiddler list view showing linked Git worktrees and branches">
</div>

## Use Fiddler

### Web

Open **[files.c0di.com](https://files.c0di.com)**.

The web build starts with a demo filesystem. In Chromium-based browsers, use **Open Folder…** to grant read/write access to a real local folder. You can also drag files or folders into the app.

The web build is static and does not upload opened files to a server. It does not provide real Git status, USB access, mounted volumes, or real nearby-device networking.

### macOS

Fiddler supports macOS 11 and newer.

To run from source, install Node.js, Rust, and the normal Tauri macOS prerequisites, then:

```bash
npm ci
npm run tauri -- dev
```

Build the native app with:

```bash
npm run tauri -- build
```

### Android / Samsung DeX

The Android build supports touch, keyboard, and pointer input. Long-press starts selection on touch devices; after that, tap additional items to toggle them. Share uses Android's system chooser, and incoming files from Open with/share flows open in Fiddler.

Build a debug ARM64 APK with a configured Tauri Android toolchain:

```bash
npm ci
npm run tauri -- android build --debug --target aarch64
```

Android deletions are permanent and require confirmation because Android does not provide Fiddler with a system Trash.

## Common controls

| Action | Shortcut |
| --- | --- |
| Icon / list view | `⌘1` / `⌘2` |
| Back / forward / enclosing folder | `⌘[` / `⌘]` / `⌘↑` |
| Quick Look | `Space` |
| Toggle preview pane | `⇧⌘P` |
| Show hidden files | `⇧⌘.` |
| Search | `⌘F` |
| Copy / cut / paste | `⌘C` / `⌘X` / `⌘V` |
| Duplicate / undo | `⌘D` / `⌘Z` |
| New folder / text file | `⇧⌘N` / `⌘N` |
| Move to Trash | `⌘⌫` |
| Refresh | `F5` or `⌘R` |

On Android and the web, use `Ctrl` where the interface shows `⌘`. With a DeX keyboard, `Enter` opens, `F2` renames, `Delete` deletes, and `Alt+←` / `Alt+→` move through history.

Right-click an item for file actions on pointer devices. Long-press on touch devices to select and access the same actions.

### PDF reader

| Action | Shortcut |
| --- | --- |
| Previous / next page | `←` / `→`, `PageUp` / `PageDown`, or `Space` |
| First / last page | `Home` / `End` |
| Full screen | `F` |
| Fit page / width | `W` |
| Single page / spread | `D` |
| Exit full screen / close | `Esc` |

Touch users can swipe or tap page-turn areas to move through a PDF.

## Development

Run the web app locally:

```bash
npm ci
npm run dev:web
```

Build the web app:

```bash
npm run build:web
```

Run the TypeScript tests:

```bash
npm test
```

Run the Rust tests:

```bash
cd src-tauri
cargo test
```

Deploy the web build to the configured Cloudflare custom domain:

```bash
npm run deploy
```

## Current limitations

- No tabs or column view yet.
- Drag and drop works inside Fiddler, but native drag in/out of Finder is not implemented yet.
- The browser build cannot provide native Git, USB/MTP, volume, or real nearby-device features.
