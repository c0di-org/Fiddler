import * as ipc from "../ipc";
import { kindOf } from "../kind";
import { natural } from "../sort";
import type { DirListing, Entry, RepoStatusPayload, Rollup, WorktreeInfo } from "../types";

export type SortKey = "name" | "kind" | "size" | "modified";
export type ViewMode = "icons" | "list";

/** One line in the list view. The grid consumes `items()` instead. */
export type Row =
  | {
      kind: "entry";
      id: string;
      depth: number;
      dirPath: string | null;
      entry: Entry;
      expanded: boolean;
    }
  | {
      kind: "wt-group";
      id: string;
      depth: number;
      dirPath: null;
      repoRoot: string;
      count: number;
      expanded: boolean;
    }
  | {
      kind: "worktree";
      id: string;
      depth: number;
      dirPath: string;
      wt: WorktreeInfo;
      expanded: boolean;
    };

type Listener = () => void;

const wtGroupId = (repoRoot: string) => ` wt:${repoRoot}`;
const wtRowId = (repoRoot: string, path: string) => ` wt:${repoRoot} ${path}`;

export class TreeStore {
  path = "";
  showHidden = false;
  sortKey: SortKey = "name";
  sortAsc = true;
  view: ViewMode = "icons";
  iconSize = 96;
  previewOpen = false;

  private history: string[] = [];
  private historyAt = -1;

  private listings = new Map<string, DirListing>();
  private sorted = new Map<string, Entry[]>();
  private expanded = new Set<string>();
  private loading = new Set<string>();
  private repoStatus = new Map<string, RepoStatusPayload>();

  private listeners = new Set<Listener>();
  private cachedRows: Row[] | null = null;
  private version = 0;

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.version;

  private bump() {
    this.cachedRows = null;
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // -------------------------------------------------------------- current

  get listing(): DirListing | undefined {
    return this.listings.get(this.path);
  }

  /** Current folder's contents, sorted — what the grid draws. */
  get entries(): Entry[] {
    return this.sortedEntries(this.path);
  }

  get worktrees(): WorktreeInfo[] {
    return this.listings.get(this.path)?.worktrees ?? [];
  }

  /** True once a listing for the current path has actually arrived. */
  get loaded() {
    return this.listings.has(this.path);
  }

  get busy() {
    return this.loading.has(this.path);
  }

  get canBack() {
    return this.historyAt > 0;
  }

  get canForward() {
    return this.historyAt < this.history.length - 1;
  }

  repoStatusFor(root: string) {
    return this.repoStatus.get(root);
  }

  private sortedEntries(dir: string): Entry[] {
    const hit = this.sorted.get(dir);
    if (hit) return hit;

    const listing = this.listings.get(dir);
    if (!listing) return [];

    const dirs: Entry[] = [];
    const files: Entry[] = [];
    for (const e of listing.entries) {
      (e.kind === "dir" || (e.kind === "symlink" && e.linkToDir) ? dirs : files).push(e);
    }

    const cmp = this.comparator();
    dirs.sort(cmp);
    files.sort(cmp);
    // Folders stay on top: in a developer's tree that beats interleaving, and it
    // keeps the grid's first row scannable.
    const out = [...dirs, ...files];
    this.sorted.set(dir, out);
    return out;
  }

  private comparator(): (a: Entry, b: Entry) => number {
    const dir = this.sortAsc ? 1 : -1;
    switch (this.sortKey) {
      case "size":
        return (a, b) => dir * (a.size - b.size || natural(a.name, b.name));
      case "modified":
        return (a, b) => dir * (a.mtime - b.mtime || natural(a.name, b.name));
      case "kind":
        return (a, b) => dir * (kindOf(a).localeCompare(kindOf(b)) || natural(a.name, b.name));
      default:
        return (a, b) => dir * natural(a.name, b.name);
    }
  }

  setSort(key: SortKey) {
    if (this.sortKey === key) this.sortAsc = !this.sortAsc;
    else {
      this.sortKey = key;
      // Names read best A→Z; sizes and dates read best largest/newest first.
      this.sortAsc = key === "name" || key === "kind";
    }
    this.sorted.clear();
    this.bump();
  }

  setView(view: ViewMode) {
    if (this.view === view) return;
    this.view = view;
    this.bump();
  }

  togglePreview() {
    this.previewOpen = !this.previewOpen;
    this.bump();
  }

  setIconSize(px: number) {
    this.iconSize = px;
    this.bump();
  }

  // ----------------------------------------------------------- navigation

  async navigate(path: string, record = true) {
    if (record) {
      this.history = this.history.slice(0, this.historyAt + 1);
      if (this.history[this.historyAt] !== path) {
        this.history.push(path);
        this.historyAt = this.history.length - 1;
      }
    }
    this.path = path;
    this.expanded.clear();
    this.bump();
    await this.load(path);
  }

  async back() {
    if (!this.canBack) return;
    this.historyAt--;
    await this.navigate(this.history[this.historyAt], false);
  }

  async forward() {
    if (!this.canForward) return;
    this.historyAt++;
    await this.navigate(this.history[this.historyAt], false);
  }

  async up() {
    const i = this.path.lastIndexOf("/");
    if (i > 0) await this.navigate(this.path.slice(0, i));
  }

  async setShowHidden(v: boolean) {
    if (this.showHidden === v) return;
    this.showHidden = v;
    const open = [...this.listings.keys()];
    this.listings.clear();
    this.sorted.clear();
    this.bump();
    await Promise.all(open.map((p) => this.load(p)));
  }

  // ---------------------------------------------------------- list rows

  get rows(): Row[] {
    if (!this.cachedRows) this.cachedRows = this.flatten();
    return this.cachedRows;
  }

  private flatten(): Row[] {
    const out: Row[] = [];
    if (this.path) this.walk(this.path, 0, out);
    return out;
  }

  private walk(dir: string, depth: number, out: Row[]) {
    const listing = this.listings.get(dir);
    if (!listing) return;

    for (const entry of this.sortedEntries(dir)) {
      const navigable = entry.kind === "dir" || (entry.kind === "symlink" && entry.linkToDir);
      const isOpen = navigable && this.expanded.has(entry.path);
      out.push({
        kind: "entry",
        id: entry.path,
        depth,
        dirPath: navigable ? entry.path : null,
        entry,
        expanded: isOpen,
      });
      if (isOpen) this.walk(entry.path, depth + 1, out);
    }

    if (listing.worktrees.length > 0 && listing.repoRoot) {
      const gid = wtGroupId(listing.repoRoot);
      const open = this.expanded.has(gid);
      out.push({
        kind: "wt-group",
        id: gid,
        depth,
        dirPath: null,
        repoRoot: listing.repoRoot,
        count: listing.worktrees.length,
        expanded: open,
      });
      if (open) {
        for (const wt of listing.worktrees) {
          const id = wtRowId(listing.repoRoot, wt.path);
          const wtOpen = !wt.prunable && this.expanded.has(id);
          out.push({
            kind: "worktree",
            id,
            depth: depth + 1,
            dirPath: wt.path,
            wt,
            expanded: wtOpen,
          });
          if (wtOpen) this.walk(wt.path, depth + 2, out);
        }
      }
    }
  }

  isExpanded(id: string) {
    return this.expanded.has(id);
  }

  async expand(row: Row) {
    if (this.expanded.has(row.id)) return;
    this.expanded.add(row.id);
    this.bump();
    if (row.dirPath && !this.listings.has(row.dirPath)) await this.load(row.dirPath);
  }

  collapse(row: Row) {
    if (this.expanded.delete(row.id)) this.bump();
  }

  async toggle(row: Row) {
    if (this.expanded.has(row.id)) this.collapse(row);
    else await this.expand(row);
  }

  // -------------------------------------------------------------- loading

  private async load(path: string) {
    if (this.loading.has(path)) return;
    this.loading.add(path);
    try {
      const listing = await ipc.listDir(path, this.showHidden);
      this.listings.set(path, listing);
      this.sorted.delete(path);
      this.bump();
    } catch (err) {
      // Surface the reason rather than rendering an unreadable folder as empty —
      // "no permission" and "genuinely empty" must never look the same.
      this.listings.set(path, {
        path,
        entries: [],
        repoRoot: null,
        worktrees: [],
        statusPending: false,
        error: String(err),
      });
      this.sorted.delete(path);
      this.bump();
    } finally {
      this.loading.delete(path);
    }
  }

  async invalidateDirs(dirs: string[]) {
    const open = dirs.filter((d) => this.listings.has(d));
    if (open.length === 0) return;
    await Promise.all(
      open.map(async (d) => {
        this.loading.delete(d);
        await this.load(d);
      })
    );
  }

  async applyRepoStatus(p: RepoStatusPayload) {
    this.repoStatus.set(p.root, p);

    let touched = false;
    for (const listing of this.listings.values()) {
      for (const e of listing.entries) {
        if (e.path !== p.root) continue;
        e.branch = p.branch ?? p.head ?? e.branch;
        e.rollup = total(p.rollup) > 0 ? p.rollup : null;
        touched = true;
      }
    }
    if (touched) this.bump();

    const under = [...this.listings.keys()].filter(
      (d) => d === p.root || d.startsWith(p.root + "/")
    );
    if (under.length > 0) await Promise.all(under.map((d) => this.load(d)));
  }
}

function total(r: Rollup) {
  return r.staged + r.modified + r.untracked + r.deleted + r.conflicted;
}
