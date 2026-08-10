/** A filesystem that lives in the tab.
 *
 * This backs both the demo tree and anything dragged onto the window. Edits are
 * real — they just don't outlive the session, which is the honest bargain for a
 * file browser that never asked for your disk. */

import type { Node, Provider } from "./vfs";

interface MemDir {
  kind: "dir";
  name: string;
  mtime: number;
  added: number;
  children: Map<string, MemEntry>;
}

interface MemFile {
  kind: "file";
  name: string;
  mtime: number;
  added: number;
  data: Blob;
}

type MemEntry = MemDir | MemFile;

const now = () => Math.floor(Date.now() / 1000);

function emptyDir(name: string, at = now()): MemDir {
  return { kind: "dir", name, mtime: at, added: at, children: new Map() };
}

export class MemoryProvider implements Provider {
  readonly readOnly: boolean;
  private root: MemDir;

  constructor(readOnly = false) {
    this.readOnly = readOnly;
    this.root = emptyDir("");
  }

  // ------------------------------------------------------------ authoring

  /** Adds a file, creating any missing parents. Used to build the demo tree and
   * to absorb dropped files; `mtime` is explicit so demo content can look lived
   * in rather than all created at page load. */
  seedFile(path: string, data: Blob, mtime = now(), added = mtime) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error(`Not a file path: ${path}`);
    const dir = this.ensureDir(parts, mtime);
    dir.children.set(name, { kind: "file", name, mtime, added, data });
  }

  seedDir(path: string, mtime = now()) {
    this.ensureDir(path.split("/").filter(Boolean), mtime);
  }

  private ensureDir(parts: string[], mtime: number): MemDir {
    let dir = this.root;
    for (const part of parts) {
      const next = dir.children.get(part);
      if (next && next.kind === "dir") {
        dir = next;
      } else if (next) {
        throw new Error(`“${part}” is a file, not a folder`);
      } else {
        const made = emptyDir(part, mtime);
        dir.children.set(part, made);
        dir = made;
      }
    }
    return dir;
  }

  // ------------------------------------------------------------- lookups

  private find(rel: string[]): MemEntry | null {
    let entry: MemEntry = this.root;
    for (const part of rel) {
      if (entry.kind !== "dir") return null;
      const next = entry.children.get(part);
      if (!next) return null;
      entry = next;
    }
    return entry;
  }

  private findDir(rel: string[]): MemDir {
    const entry = this.find(rel);
    if (!entry) throw new Error(`No such folder: /${rel.join("/")}`);
    if (entry.kind !== "dir") throw new Error(`Not a folder: /${rel.join("/")}`);
    return entry;
  }

  private parentOf(rel: string[]): { dir: MemDir; name: string } {
    const parts = [...rel];
    const name = parts.pop();
    if (!name) throw new Error("That location has no parent");
    return { dir: this.findDir(parts), name };
  }

  // ------------------------------------------------------------- Provider

  async list(rel: string[]): Promise<Node[]> {
    return [...this.findDir(rel).children.values()].map(describe);
  }

  async stat(rel: string[]): Promise<Node | null> {
    const entry = this.find(rel);
    return entry ? describe(entry) : null;
  }

  async read(rel: string[]): Promise<Blob> {
    const entry = this.find(rel);
    if (!entry) throw new Error(`No such file: /${rel.join("/")}`);
    if (entry.kind !== "file") throw new Error(`Not a file: /${rel.join("/")}`);
    return entry.data;
  }

  async write(rel: string[], data: Blob): Promise<void> {
    const { dir, name } = this.parentOf(rel);
    const existing = dir.children.get(name);
    if (existing && existing.kind === "dir") throw new Error(`“${name}” is a folder`);
    dir.children.set(name, {
      kind: "file",
      name,
      data,
      mtime: now(),
      added: existing?.added ?? now(),
    });
  }

  async mkdir(rel: string[]): Promise<void> {
    const { dir, name } = this.parentOf(rel);
    if (dir.children.has(name)) throw new Error(`“${name}” already exists`);
    dir.children.set(name, emptyDir(name));
  }

  async rename(rel: string[], newName: string): Promise<void> {
    const { dir, name } = this.parentOf(rel);
    const entry = dir.children.get(name);
    if (!entry) throw new Error(`No such item: ${name}`);
    if (newName !== name && dir.children.has(newName)) {
      throw new Error(`“${newName}” already exists`);
    }
    // Rebuilt rather than mutated in place so the Map's insertion order puts the
    // renamed item where it was, not at the end — the grid sorts, but the list
    // view's tree walk reads this order for anything sorting equal.
    const rebuilt = new Map<string, MemEntry>();
    for (const [key, value] of dir.children) {
      if (key === name) rebuilt.set(newName, { ...value, name: newName });
      else rebuilt.set(key, value);
    }
    dir.children = rebuilt;
  }

  async remove(rel: string[]): Promise<void> {
    const { dir, name } = this.parentOf(rel);
    if (!dir.children.delete(name)) throw new Error(`No such item: ${name}`);
  }
}

function describe(entry: MemEntry): Node {
  return {
    name: entry.name,
    kind: entry.kind,
    size: entry.kind === "file" ? entry.data.size : 0,
    mtime: entry.mtime,
    added: entry.added,
  };
}
