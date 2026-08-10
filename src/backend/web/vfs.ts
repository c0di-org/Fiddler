/** The shape of a filesystem, as far as the browser build is concerned.
 *
 * Paths look like `/Demo/Projects/notes.md`: the first segment names a *mount*,
 * everything after it is that mount's business. Three kinds of mount exist —
 * the bundled demo tree, a real folder the user picked with the File System
 * Access API, and whatever they dragged onto the window — and the rest of the
 * backend is written against this interface so it never has to care which. */

export interface Node {
  name: string;
  kind: "dir" | "file";
  /** Bytes. Zero for directories. */
  size: number;
  /** Unix seconds. */
  mtime: number;
  /** Unix seconds; falls back to `mtime` where the source has no birth time. */
  added: number;
}

export interface Provider {
  /** Whether writes should even be offered. */
  readonly readOnly: boolean;
  list(rel: string[]): Promise<Node[]>;
  stat(rel: string[]): Promise<Node | null>;
  /** The file's bytes. Rejects for directories and missing paths. */
  read(rel: string[]): Promise<Blob>;
  /** Create or overwrite a file. Parent directories must already exist. */
  write(rel: string[], data: Blob): Promise<void>;
  mkdir(rel: string[]): Promise<void>;
  /** Rename in place; `rel` keeps its parent and takes a new last segment. */
  rename(rel: string[], newName: string): Promise<void>;
  /** Recursively remove a file or directory. */
  remove(rel: string[]): Promise<void>;
}

export interface Mount {
  /** The first path segment, and so unique. */
  id: string;
  /** What the sidebar calls it. */
  name: string;
  /** A `Place` icon name; see `placeIcon` in `components/icons.tsx`. */
  icon: string;
  /** Shown in the sidebar's Places list. Dropped files are reachable but not
   * advertised until something has actually been dropped. */
  listed: boolean;
  provider: Provider;
}

// ------------------------------------------------------------------- paths

export function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export function joinSegments(parts: string[]): string {
  // Above the mounts there is nothing to name, so the root joins to the empty
  // string rather than "/". That keeps `touchDir` from ever announcing a
  // directory no listing can exist for.
  return parts.length === 0 ? "" : "/" + parts.join("/");
}

export function basename(path: string): string {
  const parts = segments(path);
  return parts[parts.length - 1] ?? "";
}

export function parentOf(path: string): string {
  const parts = segments(path);
  parts.pop();
  return joinSegments(parts);
}

export function childPath(parent: string, name: string): string {
  return joinSegments([...segments(parent), name]);
}

/** A name that can't traverse out of its directory or collide with the path
 * separator. Every rename and create goes through this. */
export function validName(name: string): string {
  const clean = name.trim();
  if (clean.length === 0) throw new Error("A name can’t be empty");
  if (clean === "." || clean === "..") throw new Error(`“${clean}” isn’t a usable name`);
  if (clean.includes("/")) throw new Error("A name can’t contain “/”");
  return clean;
}

// ------------------------------------------------------------------ mounts

const mounts = new Map<string, Mount>();
const mountOrder: string[] = [];

export function addMount(mount: Mount) {
  if (!mounts.has(mount.id)) mountOrder.push(mount.id);
  mounts.set(mount.id, mount);
}

export function allMounts(): Mount[] {
  return mountOrder.map((id) => mounts.get(id)!).filter(Boolean);
}

export function mountExists(id: string): boolean {
  return mounts.has(id);
}

/** Splits a path into the mount that owns it and the path within it. */
export function resolve(path: string): { mount: Mount; rel: string[] } {
  const parts = segments(path);
  const mount = mounts.get(parts[0] ?? "");
  if (!mount) throw new Error(`No such location: ${path || "/"}`);
  return { mount, rel: parts.slice(1) };
}

/** A mount id derived from a display name, made unique against what's mounted.
 * Users pick real folder names, and two different `src` folders must not
 * become the same location. */
export function uniqueMountId(preferred: string): string {
  const base = preferred.replace(/[/]/g, " ").trim() || "Folder";
  if (!mounts.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!mounts.has(candidate)) return candidate;
  }
}

// ------------------------------------------------------------- change feed

type DirsListener = (dirs: string[]) => void;
const dirsListeners = new Set<DirsListener>();
let pending = new Set<string>();
let flushHandle: number | null = null;

export function onDirsChanged(fn: DirsListener): () => void {
  dirsListeners.add(fn);
  return () => dirsListeners.delete(fn);
}

/** Announce that a directory's contents changed.
 *
 * The desktop build gets this from fsevents, and the UI leans on it hard: no
 * mutation refreshes its own view, and `createFolder` even sets up an inline
 * rename for a row that doesn't exist yet. Without a watcher we have to emit it
 * ourselves after every write. Coalescing on a microtask means one paste of
 * forty files still produces one refresh. */
export function touchDir(...paths: string[]) {
  for (const p of paths) if (p) pending.add(p);
  if (flushHandle !== null) return;
  // Bare `setTimeout`, not `window.setTimeout`: this module is the one piece of
  // the web backend that is pure enough to unit test outside a browser, and it
  // should stay that way.
  flushHandle = setTimeout(() => {
    flushHandle = null;
    const dirs = [...pending];
    pending = new Set();
    if (dirs.length === 0) return;
    for (const fn of dirsListeners) fn(dirs);
  }, 0);
}

// -------------------------------------------------------------- operations

export async function listDir(path: string): Promise<Node[]> {
  const { mount, rel } = resolve(path);
  return mount.provider.list(rel);
}

export async function stat(path: string): Promise<Node | null> {
  const { mount, rel } = resolve(path);
  if (rel.length === 0) {
    return { name: mount.name, kind: "dir", size: 0, mtime: 0, added: 0 };
  }
  return mount.provider.stat(rel);
}

export async function readBlob(path: string): Promise<Blob> {
  const { mount, rel } = resolve(path);
  return mount.provider.read(rel);
}

export async function writeBlob(path: string, data: Blob): Promise<void> {
  const { mount, rel } = resolve(path);
  assertWritable(mount);
  await mount.provider.write(rel, data);
  touchDir(parentOf(path));
}

export async function mkdir(path: string): Promise<void> {
  const { mount, rel } = resolve(path);
  assertWritable(mount);
  await mount.provider.mkdir(rel);
  touchDir(parentOf(path));
}

export async function rename(path: string, newName: string): Promise<string> {
  const { mount, rel } = resolve(path);
  assertWritable(mount);
  const name = validName(newName);
  if (rel.length === 0) throw new Error("This location can’t be renamed");
  await mount.provider.rename(rel, name);
  const moved = childPath(parentOf(path), name);
  touchDir(parentOf(path));
  return moved;
}

export async function remove(path: string): Promise<void> {
  const { mount, rel } = resolve(path);
  assertWritable(mount);
  if (rel.length === 0) throw new Error("This location can’t be deleted");
  await mount.provider.remove(rel);
  touchDir(parentOf(path));
}

/** Copies files and folders between any two mounts by streaming through blobs,
 * which is the one operation that has to work across providers. */
export async function copyInto(sources: string[], destination: string): Promise<string[]> {
  const { mount } = resolve(destination);
  assertWritable(mount);

  const created: string[] = [];
  for (const source of sources) {
    const node = await stat(source);
    if (!node) continue;
    const target = await freshPath(destination, node.name);
    await copyOne(source, target, node.kind);
    created.push(target);
  }
  touchDir(destination);
  return created;
}

async function copyOne(source: string, target: string, kind: Node["kind"]) {
  if (kind === "file") {
    const { mount, rel } = resolve(target);
    await mount.provider.write(rel, await readBlob(source));
    return;
  }
  const { mount, rel } = resolve(target);
  await mount.provider.mkdir(rel);
  for (const child of await listDir(source)) {
    await copyOne(childPath(source, child.name), childPath(target, child.name), child.kind);
  }
}

/** "notes.md" beside an existing "notes.md" becomes "notes copy.md", then
 * "notes copy 2.md" — the same shape Finder uses, so a paste never silently
 * overwrites the thing it landed next to. */
export async function freshPath(parent: string, name: string): Promise<string> {
  const taken = new Set((await listDir(parent)).map((n) => n.name));
  if (!taken.has(name)) return childPath(parent, name);

  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
    if (!taken.has(candidate)) return childPath(parent, candidate);
  }
}

function assertWritable(mount: Mount) {
  if (mount.provider.readOnly) {
    throw new Error(`“${mount.name}” is read-only`);
  }
}
