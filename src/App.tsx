import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { openPath } from "@tauri-apps/plugin-opener";

import { ContextMenu, type MenuItem } from "./components/ContextMenu";
import { DetailList } from "./components/DetailList";
import { GlyphDefs } from "./components/FileGlyph";
import { IconGrid, type GridCell } from "./components/IconGrid";
import { PreviewPane } from "./components/PreviewPane";
import { QuickLook } from "./components/QuickLook";
import { Sidebar } from "./components/Sidebar";
import { TintPicker } from "./components/TintPicker";
import { Toolbar } from "./components/Toolbar";
import { GridIcon } from "./components/icons";
import { formatSize } from "./format";
import * as ipc from "./ipc";
import { TreeStore, type Row } from "./store/tree";
import { applyTint, hasSystemAccent, loadTint, saveTint, watchTint, type Tint } from "./tint";
import type { Entry, Place } from "./types";

const store = new TreeStore();
const isAndroid = /Android/i.test(navigator.userAgent);

/** How long a type-to-jump buffer stays alive between keystrokes. */
const TYPE_AHEAD_MS = 900;

/** What the user currently has selected, in whichever view is showing. */
interface Target {
  id: string;
  path: string;
  name: string;
  isDir: boolean;
  entry?: Entry;
}

export default function App() {
  useSyncExternalStore(store.subscribe, store.getSnapshot);

  const [places, setPlaces] = useState<Place[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [revealSelection, setRevealSelection] = useState(0);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [quickLook, setQuickLook] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [tint, setTint] = useState<Tint>(loadTint);
  const [systemTint, setSystemTint] = useState(false);
  const anchorRef = useRef<string | null>(null);
  const typeAhead = useRef({ buffer: "", at: 0 });

  const home = places.find((p) => p.icon === "home")?.path ?? "";

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  /** Ask the current view to reveal a selection made by keyboard navigation. */
  const revealCursor = useCallback(() => setRevealSelection((n) => n + 1), []);

  // ------------------------------------------------------------ bootstrap

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ps = await ipc.sidebarPlaces();
      if (cancelled) return;
      setPlaces(ps);
      const start = ps.find((p) => p.icon === "code") ?? ps[0];
      if (start) await store.navigate(start.path);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The accent follows the OS unless overridden, and has to be re-derived when
  // the appearance flips or the OS accent changes while we're running.
  useEffect(() => {
    applyTint(tint);
    saveTint(tint);
  }, [tint]);

  const tintRef = useRef(tint);
  tintRef.current = tint;
  useEffect(() => watchTint(() => tintRef.current, () => setSystemTint(hasSystemAccent())), []);

  useEffect(() => {
    const subs = [
      ipc.onRepoStatus((p) => void store.applyRepoStatus(p)),
      ipc.onDirsChanged((dirs) => void store.invalidateDirs(dirs)),
    ];
    return () => {
      for (const s of subs) void s.then((off) => off());
    };
  }, []);

  // ----------------------------------------------------------------- data

  const q = filter.trim().toLowerCase();

  const gridEntries = useMemo(
    () => (q ? store.entries.filter((e) => e.name.toLowerCase().includes(q)) : store.entries),
    [store.entries, q]
  );
  const gridWorktrees = useMemo(
    () => (q ? store.worktrees.filter((w) => w.name.toLowerCase().includes(q)) : store.worktrees),
    [store.worktrees, q]
  );
  const listRows = useMemo(() => applyFilter(store.rows, q), [store.rows, q]);

  /** Flat, ordered list of everything selectable in the current view. */
  const targets = useMemo<Target[]>(() => {
    if (store.view === "icons") {
      return [
        ...gridEntries.map((e) => ({
          id: e.path,
          path: e.path,
          name: e.name,
          isDir: e.kind === "dir" || (e.kind === "symlink" && e.linkToDir),
          entry: e,
        })),
        ...gridWorktrees.map((w) => ({
          id: `wt:${w.path}`,
          path: w.path,
          name: w.name,
          isDir: true,
        })),
      ];
    }
    return listRows.flatMap((r) =>
      r.kind === "wt-group"
        ? []
        : [
            {
              id: r.id,
              path: r.kind === "entry" ? r.entry.path : r.wt.path,
              name: r.kind === "entry" ? r.entry.name : r.wt.name,
              isDir: r.dirPath !== null,
              entry: r.kind === "entry" ? r.entry : undefined,
            },
          ]
    );
  }, [store.view, gridEntries, gridWorktrees, listRows]);

  const byId = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);
  const selected = useMemo(
    () => [...selection].map((id) => byId.get(id)).filter((t): t is Target => !!t),
    [selection, byId]
  );

  const currentBranch = useMemo(() => {
    const root = store.listing?.repoRoot;
    if (!root) return null;
    const st = store.repoStatusFor(root);
    return st?.branch ?? st?.head ?? null;
  }, [store.listing, store.getSnapshot()]);

  // -------------------------------------------------------------- actions

  const go = useCallback(async (path: string) => {
    setSelection(new Set());
    setFilter("");
    setQuickLook(false);
    await store.navigate(path);
  }, []);

  /** The item Quick Look would show: the most recently selected one. */
  const lead = useMemo(() => {
    const id = [...selection].pop();
    const at = id ? targets.findIndex((t) => t.id === id) : -1;
    return at >= 0 ? { at, target: targets[at] } : null;
  }, [selection, targets]);

  const openTarget = useCallback(
    async (t: Target) => {
      if (t.isDir) {
        await go(t.path);
        return;
      }
      try {
        await openPath(t.path);
      } catch {
        flash(`Could not open “${t.name}”`);
      }
    },
    [go, flash]
  );

  /** Click selection with the usual ⌘ / ⇧ semantics. */
  const select = useCallback(
    (id: string, e: React.MouseEvent) => {
      setSelection((prev) => {
        if (e.metaKey || e.ctrlKey) {
          const next = new Set(prev);
          next.has(id) ? next.delete(id) : next.add(id);
          anchorRef.current = id;
          return next;
        }
        if (e.shiftKey && anchorRef.current) {
          const from = targets.findIndex((t) => t.id === anchorRef.current);
          const to = targets.findIndex((t) => t.id === id);
          if (from >= 0 && to >= 0) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            return new Set(targets.slice(lo, hi + 1).map((t) => t.id));
          }
        }
        anchorRef.current = id;
        return new Set([id]);
      });
    },
    [targets]
  );

  const moveCursor = useCallback(
    (delta: number, extend: boolean) => {
      if (targets.length === 0) return;
      const lead = [...selection].pop();
      const at = lead ? targets.findIndex((t) => t.id === lead) : -1;
      const next = Math.max(0, Math.min(targets.length - 1, at + delta));
      const id = targets[next].id;
      setSelection((prev) => {
        if (!extend) return new Set([id]);
        const s = new Set(prev);
        s.add(id);
        return s;
      });
      revealCursor();
      if (!extend) anchorRef.current = id;
    },
    [targets, selection, revealCursor]
  );

  const trashSelected = useCallback(async () => {
    const paths = selected.filter((t) => t.entry).map((t) => t.path);
    if (paths.length === 0) return;
    try {
      await ipc.trashPaths(paths);
      setSelection(new Set());
    } catch (e) {
      flash(String(e));
    }
  }, [selected, flash]);

  const newFolder = useCallback(async () => {
    try {
      const created = await ipc.createFolder(store.path, "untitled folder");
      setSelection(new Set([created]));
      setRenamingId(created);
      if (store.view === "icons") flash("Folder created — switch to List view to rename inline");
    } catch (e) {
      flash(String(e));
    }
  }, [flash]);

  const commitRename = useCallback(
    async (row: Row, name: string) => {
      setRenamingId(null);
      const path = row.kind === "entry" ? row.entry.path : row.kind === "worktree" ? row.wt.path : null;
      const current = row.kind === "entry" ? row.entry.name : row.kind === "worktree" ? row.wt.name : "";
      if (!path || name === current) return;
      try {
        const moved = await ipc.renamePath(path, name);
        setSelection(new Set([moved]));
      } catch (e) {
        flash(String(e));
      }
    },
    [flash]
  );

  const buildMenu = useCallback(
    (t: Target | null, x: number, y: number) => {
      const items: MenuItem[] = [];

      if (t) {
        items.push({ label: t.isDir ? "Open" : "Open", onPick: () => void openTarget(t) });
        if (!isAndroid) {
          items.push({ label: "Reveal in Finder", onPick: () => void ipc.revealInFinder(t.path) });
          items.push({ label: "Open in Terminal", onPick: () => void ipc.openTerminalHere(t.path) });
        }
        items.push({
          label: "Copy Path",
          separatorBefore: true,
          onPick: () => void navigator.clipboard.writeText(t.path),
        });
        if (t.entry) {
          items.push({ label: "Rename…", onPick: () => setRenamingId(t.id) });
          if (!isAndroid) {
            items.push({
              label: selected.length > 1 ? `Move ${selected.length} Items to Trash` : "Move to Trash",
              danger: true,
              separatorBefore: true,
              onPick: () => void trashSelected(),
            });
          }
        }
      } else {
        items.push({ label: "New Folder", onPick: () => void newFolder() });
        if (!isAndroid) items.push({ label: "Open in Terminal", onPick: () => void ipc.openTerminalHere(store.path) });
        const root = store.listing?.repoRoot;
        if (root) {
          items.push({
            label: "Refresh Git Status",
            separatorBefore: true,
            onPick: () => void ipc.refreshRepo(root),
          });
        }
      }

      setMenu({ x, y, items });
    },
    [openTarget, selected.length, trashSelected, newFolder]
  );

  // ------------------------------------------------------------- keyboard

  /**
   * Finder's type-to-jump: printable keys accumulate into a short-lived buffer
   * and select the first item whose name starts with it. The buffer resets after
   * a pause so a new burst starts a fresh search.
   */
  const jumpTo = useCallback(
    (ch: string) => {
      const now = Date.now();
      const ta = typeAhead.current;
      ta.buffer = now - ta.at > TYPE_AHEAD_MS ? ch : ta.buffer + ch;
      ta.at = now;

      const q = ta.buffer.toLowerCase();
      // Repeating one letter cycles through the items starting with it.
      const repeated = q.length > 1 && [...q].every((c) => c === q[0]);
      const needle = repeated ? q[0] : q;

      const lead = [...selection].pop();
      const from = repeated && lead ? targets.findIndex((t) => t.id === lead) + 1 : 0;

      for (let i = 0; i < targets.length; i++) {
        const t = targets[(from + i) % targets.length];
        if (t.name.toLowerCase().startsWith(needle)) {
          setSelection(new Set([t.id]));
          revealCursor();
          anchorRef.current = t.id;
          return;
        }
      }
    },
    [targets, selection, revealCursor]
  );

  const kb = useRef({ targets, selection, moveCursor, openTarget, trashSelected, newFolder, go, jumpTo, quickLook });
  kb.current = { targets, selection, moveCursor, openTarget, trashSelected, newFolder, go, jumpTo, quickLook };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.isContentEditable) {
        if (e.key === "Escape") (el as HTMLInputElement).blur();
        return;
      }

      const s = kb.current;
      const modifier = e.metaKey || e.ctrlKey;
      // The viewer owns the keyboard while it's up: it has already handled the
      // keys it cares about, and the rest must not reach the folder behind it.
      if (s.quickLook) return;
      const lead = [...s.selection].pop();
      const target = lead ? s.targets.find((t) => t.id === lead) : undefined;
      const perRow = store.view === "icons" ? iconsPerRow() : 1;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          s.moveCursor(perRow, e.shiftKey);
          break;
        case "ArrowUp":
          if (modifier) {
            e.preventDefault();
            void store.up();
            setSelection(new Set());
          } else {
            e.preventDefault();
            s.moveCursor(-perRow, e.shiftKey);
          }
          break;
        case "ArrowRight":
          if (store.view === "icons") {
            e.preventDefault();
            s.moveCursor(1, e.shiftKey);
          }
          break;
        case "ArrowLeft":
          if (store.view === "icons") {
            e.preventDefault();
            s.moveCursor(-1, e.shiftKey);
          }
          break;
        case "Enter":
          if (target) {
            e.preventDefault();
            if (modifier) void s.openTarget(target);
            else setRenamingId(target.id);
          }
          break;
        case "o":
          if (modifier && target) {
            e.preventDefault();
            void s.openTarget(target);
          }
          break;
        case "Backspace":
          if (modifier) {
            e.preventDefault();
            void s.trashSelected();
          }
          break;
        case "n":
          if (modifier && e.shiftKey) {
            e.preventDefault();
            void s.newFolder();
          }
          break;
        case "a":
          if (modifier) {
            e.preventDefault();
            setSelection(new Set(s.targets.map((t) => t.id)));
          }
          break;
        case "p":
          if (modifier && e.shiftKey) {
            e.preventDefault();
            store.togglePreview();
          }
          break;
        case "1":
          if (modifier) {
            e.preventDefault();
            store.setView("icons");
          }
          break;
        case "2":
          if (modifier) {
            e.preventDefault();
            store.setView("list");
          }
          break;
        case "[":
          if (modifier) {
            e.preventDefault();
            void store.back();
          }
          break;
        case "]":
          if (modifier) {
            e.preventDefault();
            void store.forward();
          }
          break;
        case ".":
          if (modifier && e.shiftKey) {
            e.preventDefault();
            void store.setShowHidden(!store.showHidden);
          }
          break;
        case " ":
          // Quick Look, as everywhere else on this OS.
          if (target?.entry && !modifier) {
            e.preventDefault();
            setQuickLook(true);
          }
          break;
        case "Escape":
          setFilter("");
          setSelection(new Set());
          break;
        default:
          // Anything else printable starts (or continues) a type-to-jump search.
          if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && e.key !== " ") {
            e.preventDefault();
            s.jumpTo(e.key);
          }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ----------------------------------------------------------------- view

  const emptyMessage = useMemo(() => {
    const err = store.listing?.error;
    if (!err) return q ? "No matches" : "This folder is empty";
    return /denied|not permitted|Operation not permitted/i.test(err)
      ? isAndroid
        ? "Fiddler needs All files access to browse shared storage.\nAllow it in Android Settings, then return here."
        : "Fiddler doesn’t have permission to read this folder.\nGrant access in System Settings › Privacy & Security › Files and Folders."
      : err.replace(/^Error:\s*/, "");
  }, [store.listing, q]);

  const statusText = useMemo(() => {
    if (selected.length === 1 && selected[0].entry && !selected[0].isDir) {
      return `${selected[0].name} — ${formatSize(selected[0].entry.size, false)}`;
    }
    if (selected.length > 1) return `${selected.length} of ${targets.length} selected`;
    return `${targets.length} item${targets.length === 1 ? "" : "s"}`;
  }, [selected, targets.length]);

  return (
    <div className="app">
      <GlyphDefs />
      <Sidebar places={places} current={store.path} onPick={(p) => void go(p)} />

      <main className="main">
        <Toolbar
          path={store.path}
          home={home}
          view={store.view}
          filter={filter}
          showHidden={store.showHidden}
          canBack={store.canBack}
          canForward={store.canForward}
          branch={currentBranch}
          onBack={() => void store.back()}
          onForward={() => void store.forward()}
          onUp={() => void store.up()}
          onCrumb={(p) => void go(p)}
          onView={(v) => store.setView(v)}
          previewOpen={store.previewOpen}
          onFilter={setFilter}
          onToggleHidden={() => void store.setShowHidden(!store.showHidden)}
          onTogglePreview={() => store.togglePreview()}
        />

        <div className="body">
          {store.view === "icons" ? (
            <IconGrid
              emptyMessage={emptyMessage}
              loaded={store.loaded}
              entries={gridEntries}
              worktrees={gridWorktrees}
              iconSize={store.iconSize}
              selection={selection}
              revealSelection={revealSelection}
              onSelect={select}
              onOpen={(c: GridCell) => {
                const t = byId.get(c.id);
                if (t) void openTarget(t);
              }}
              onContextMenu={(c, x, y) => buildMenu(c ? (byId.get(c.id) ?? null) : null, x, y)}
              onBackgroundClick={() => setSelection(new Set())}
            />
          ) : (
            <DetailList
              emptyMessage={emptyMessage}
              loaded={store.loaded}
              rows={listRows}
              selection={selection}
              revealSelection={revealSelection}
              renamingId={renamingId}
              sortKey={store.sortKey}
              sortAsc={store.sortAsc}
              onSort={(k) => store.setSort(k)}
              onSelect={select}
              onToggle={(r) => void store.toggle(r)}
              onOpen={(r) => {
                if (r.kind === "wt-group") {
                  void store.toggle(r);
                  return;
                }
                const t = byId.get(r.id);
                if (t) void openTarget(t);
              }}
              onContextMenu={(r, x, y) => buildMenu(r ? (byId.get(r.id) ?? null) : null, x, y)}
              onRenameCommit={(r, v) => void commitRename(r, v)}
              onRenameCancel={() => setRenamingId(null)}
              onBackgroundClick={() => setSelection(new Set())}
            />
          )}

          {store.previewOpen && (
            <PreviewPane
              entry={selected.length === 1 ? selected[0].entry : undefined}
              worktree={
                selected.length === 1 && !selected[0].entry
                  ? store.worktrees.find((w) => w.path === selected[0].path)
                  : undefined
              }
              count={selected.length}
            />
          )}
        </div>

        {/* Zoom lives down here, next to the count it changes, rather than
            competing with navigation for room in the toolbar. */}
        <footer className="statusbar">
          <TintPicker tint={tint} systemAvailable={systemTint} onPick={setTint} />
          <span className="status-text">{statusText}</span>
          {store.view === "icons" && (
            <label className="status-zoom" title="Icon size">
              <GridIcon size={11} />
              <input
                type="range"
                min={56}
                max={224}
                step={8}
                value={store.iconSize}
                onChange={(e) => store.setIconSize(Number(e.target.value))}
              />
            </label>
          )}
        </footer>
      </main>

      {quickLook && lead?.target.entry && (
        <QuickLook
          entry={lead.target.entry}
          index={lead.at}
          total={targets.length}
          onStep={(d) => moveCursor(d, false)}
          onClose={() => setQuickLook(false)}
        />
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/** Approximate the grid's column count for arrow-key navigation. */
function iconsPerRow(): number {
  const scroller = document.querySelector(".grid-scroller");
  const row = document.querySelector(".grid-row");
  if (!scroller || !row) return 1;
  return Math.max(1, row.children.length);
}

/**
 * Keep rows whose name matches, plus every ancestor of a match. Runs back to
 * front: in a depth-first flattening, any earlier row that is shallower than a
 * kept row is one of its ancestors.
 */
function applyFilter(rows: Row[], q: string): Row[] {
  if (!q) return rows;

  const keep = new Array<boolean>(rows.length).fill(false);
  let shallowestKept = -1;

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const name =
      row.kind === "entry" ? row.entry.name : row.kind === "worktree" ? row.wt.name : "worktrees";

    if (name.toLowerCase().includes(q)) {
      keep[i] = true;
      shallowestKept = shallowestKept < 0 ? row.depth : Math.min(shallowestKept, row.depth);
    } else if (shallowestKept >= 0 && row.depth < shallowestKept) {
      keep[i] = true;
      shallowestKept = row.depth;
    }
  }

  return rows.filter((_, i) => keep[i]);
}
