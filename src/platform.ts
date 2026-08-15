/** What this build of Fiddler can actually do.
 *
 * This replaces a module-level `isAndroid` that had quietly come to mean five
 * different things — "is a touch device", "has no Finder", "has no Trash", "can
 * install APKs", "phrase the permission error differently". Splitting them out
 * is what lets a third target answer each question for itself: the web build is
 * touch-first on a phone and pointer-first on a laptop, has no shell to
 * integrate with, and does have a Trash of its own. */

/** Replaced by Vite at build time; see `define` in `vite.config.ts`. The
 * `typeof` guard is for Node, which runs the unit tests without Vite. */
declare const __FIDDLER_WEB__: boolean;
const isWebBuild = typeof __FIDDLER_WEB__ !== "undefined" && __FIDDLER_WEB__;

export type Platform = "macos" | "android" | "web";

export const platform: Platform = isWebBuild
  ? "web"
  : /Android/i.test(navigator.userAgent)
    ? "android"
    : "macos";

/** True where the primary pointer can't hover — a phone or tablet, or a Mac
 * being driven by touch. Finder's select-then-open two-step is wrong there:
 * a single tap should open, because there is no hover to preview intent. */
const coarsePointer = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export interface Capabilities {
  /** "Reveal in Finder" — a desktop shell we can hand a path to. */
  reveal: boolean;
  /** "Open in Terminal" here. */
  terminal: boolean;
  /** The system has a share sheet to hand files to. Android's chooser and
   * macOS's `NSSharingServicePicker` are the same verb; a tab has nothing to
   * hand a file *to*, and the browser's own Share is about the page. */
  share: boolean;
  /** Deletion is recoverable. Where it isn't, the UI must say so and confirm. */
  trash: boolean;
  /** Selecting an `.apk` should offer to install it. */
  installApk: boolean;
  /** One tap opens, rather than selecting. */
  directTouch: boolean;
  /** Other Fiddlers on the network can appear in the sidebar. True on the web
   * not because a tab has a network transport — it has none — but because the
   * demo shows what the section does, labelled as a demonstration on every row
   * it draws. See `demo-device.ts` for why that exception is drawn here and
   * nowhere near `git`. */
  nearby: boolean;
  /** Git status, branches and worktrees are real and worth showing. */
  git: boolean;
  /** The user can mount a folder from their own disk. */
  folderPicker: boolean;
  /** Files and folders dragged onto the window can be read. */
  dropImport: boolean;
  /** Opening a file hands it to the OS. Where false, "open" means download. */
  handOff: boolean;
  /** The other direction: the OS can hand *Fiddler* a file to open, because it
   * is registered as something that shows one. Android's "Open with" and share
   * sheet do this; a tab has no such door, and macOS hasn't been wired up. */
  incomingFiles: boolean;
}

/** Chromium exposes `showDirectoryPicker`; Safari and Firefox do not, and fall
 * back to the demo tree plus whatever gets dragged in. */
const hasDirectoryPicker = () =>
  typeof window !== "undefined" && "showDirectoryPicker" in window;

export const caps: Capabilities = {
  reveal: platform === "macos",
  terminal: platform === "macos",
  share: platform !== "web",
  trash: platform !== "android",
  installApk: platform === "android",
  directTouch: platform === "android" || (platform === "web" && coarsePointer()),
  nearby: true,
  git: platform !== "web",
  folderPicker: platform === "web" && hasDirectoryPicker(),
  dropImport: platform === "web",
  handOff: platform !== "web",
  incomingFiles: platform === "android",
};

/** Where to send someone whose folder we were not allowed to read. The three
 * platforms fix this in three different places. */
export function permissionHelp(): string {
  switch (platform) {
    case "android":
      return "Fiddler needs All files access to read this folder. Grant it in Android Settings › Apps › Fiddler.";
    case "web":
      return "Your browser did not grant access to this folder. Try opening it again.";
    default:
      return "Fiddler needs permission to read this folder. Grant it in System Settings › Privacy & Security › Files and Folders.";
  }
}
