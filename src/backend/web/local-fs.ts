/** A real folder on the user's disk, reached through the File System Access API.
 *
 * This is what makes the web build more than a demo: pick a folder and Fiddler
 * browses, previews and edits the actual files, with the browser — not us —
 * holding the permission. Chromium ships the API; Safari and Firefox do not, so
 * `caps.folderPicker` hides the entry point there. */

import type { Node, Provider } from "./vfs";

// The DOM lib's coverage of this API varies by TypeScript version, and the bits
// we lean on hardest (`move`, the picker itself) are the least covered. Declaring
// the slice we use keeps the build from depending on which lib we happen to get.
interface DirHandle {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, DirHandle | FileHandle]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  move?(newName: string): Promise<void>;
}

interface FileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableStream<Blob>>;
  move?(newName: string): Promise<void>;
}

type Handle = DirHandle | FileHandle;

interface PickerWindow {
  showDirectoryPicker(options?: { mode?: "read" | "readwrite"; id?: string }): Promise<DirHandle>;
}

/** Asks the browser for a folder. Rejects — including on cancel — so the caller
 * can tell "no folder" from "this folder". */
export async function pickDirectory(): Promise<DirHandle> {
  const picker = window as unknown as PickerWindow;
  if (typeof picker.showDirectoryPicker !== "function") {
    throw new Error("This browser can’t open local folders");
  }
  return picker.showDirectoryPicker({ mode: "readwrite", id: "fiddler-folder" });
}

export class LocalProvider implements Provider {
  readonly readOnly = false;
  private root: DirHandle;
  /** Directory handles by `rel.join("/")`. Re-walking from the root on every
   * keystroke of a type-ahead is the difference between instant and not. */
  private dirs = new Map<string, DirHandle>();

  constructor(root: DirHandle) {
    this.root = root;
    this.dirs.set("", root);
  }

  get rootName(): string {
    return this.root.name;
  }

  // -------------------------------------------------------------- walking

  private async dirHandle(rel: string[]): Promise<DirHandle> {
    const key = rel.join("/");
    const hit = this.dirs.get(key);
    if (hit) return hit;

    let handle = this.root;
    for (let i = 0; i < rel.length; i++) {
      const sub = rel.slice(0, i + 1).join("/");
      const cached = this.dirs.get(sub);
      if (cached) {
        handle = cached;
        continue;
      }
      handle = await handle.getDirectoryHandle(rel[i]);
      this.dirs.set(sub, handle);
    }
    return handle;
  }

  private async fileHandle(rel: string[], create = false): Promise<FileHandle> {
    const parts = [...rel];
    const name = parts.pop();
    if (!name) throw new Error("That path names a folder, not a file");
    const dir = await this.dirHandle(parts);
    return dir.getFileHandle(name, { create });
  }

  /** Anything at or under `rel` may have moved; forget it. */
  private forget(rel: string[]) {
    const prefix = rel.join("/");
    for (const key of [...this.dirs.keys()]) {
      if (key === prefix || key.startsWith(prefix + "/")) this.dirs.delete(key);
    }
  }

  // ------------------------------------------------------------- Provider

  async list(rel: string[]): Promise<Node[]> {
    const dir = await this.dirHandle(rel);
    const handles: Handle[] = [];
    for await (const [, handle] of dir.entries()) handles.push(handle);

    // Size and mtime each cost a `getFile()`, so a big folder is a lot of small
    // reads. Running them together keeps a thousand-file folder from listing
    // one file at a time; failures degrade to a zero-byte entry rather than
    // failing the whole listing.
    return Promise.all(handles.map((handle) => this.describe(rel, handle)));
  }

  private async describe(rel: string[], handle: Handle): Promise<Node> {
    if (handle.kind === "directory") {
      return { name: handle.name, kind: "dir", size: 0, mtime: 0, added: 0 };
    }
    try {
      const file = await handle.getFile();
      const mtime = Math.floor(file.lastModified / 1000);
      return { name: handle.name, kind: "file", size: file.size, mtime, added: mtime };
    } catch {
      this.forget(rel);
      return { name: handle.name, kind: "file", size: 0, mtime: 0, added: 0 };
    }
  }

  async stat(rel: string[]): Promise<Node | null> {
    if (rel.length === 0) {
      return { name: this.root.name, kind: "dir", size: 0, mtime: 0, added: 0 };
    }
    const parts = [...rel];
    const name = parts.pop()!;
    const dir = await this.dirHandle(parts);
    try {
      const file = await dir.getFileHandle(name);
      return this.describe(parts, file);
    } catch {
      try {
        const sub = await dir.getDirectoryHandle(name);
        return this.describe(parts, sub);
      } catch {
        return null;
      }
    }
  }

  async read(rel: string[]): Promise<Blob> {
    return (await this.fileHandle(rel)).getFile();
  }

  async write(rel: string[], data: Blob): Promise<void> {
    const handle = await this.fileHandle(rel, true);
    const writable = await handle.createWritable();
    const writer = writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      await writer.close();
    }
  }

  async mkdir(rel: string[]): Promise<void> {
    const parts = [...rel];
    const name = parts.pop();
    if (!name) throw new Error("That path has no parent");
    const dir = await this.dirHandle(parts);
    // `create: true` is idempotent, so an explicit existence check is what makes
    // "New Folder" twice in a row produce two folders rather than silently one.
    if (await this.has(dir, name)) throw new Error(`“${name}” already exists`);
    await dir.getDirectoryHandle(name, { create: true });
  }

  private async has(dir: DirHandle, name: string): Promise<boolean> {
    try {
      await dir.getDirectoryHandle(name);
      return true;
    } catch {
      try {
        await dir.getFileHandle(name);
        return true;
      } catch {
        return false;
      }
    }
  }

  async rename(rel: string[], newName: string): Promise<void> {
    const parts = [...rel];
    const name = parts.pop();
    if (!name) throw new Error("That location can’t be renamed");
    const dir = await this.dirHandle(parts);
    if (newName !== name && (await this.has(dir, newName))) {
      throw new Error(`“${newName}” already exists`);
    }

    let handle: Handle;
    try {
      handle = await dir.getFileHandle(name);
    } catch {
      handle = await dir.getDirectoryHandle(name);
    }
    if (typeof handle.move !== "function") {
      throw new Error("This browser can’t rename local files");
    }
    await handle.move(newName);
    this.forget(parts.concat(name));
  }

  async remove(rel: string[]): Promise<void> {
    const parts = [...rel];
    const name = parts.pop();
    if (!name) throw new Error("That location can’t be deleted");
    const dir = await this.dirHandle(parts);
    await dir.removeEntry(name, { recursive: true });
    this.forget(parts.concat(name));
  }
}
