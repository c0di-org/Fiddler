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
import { TextEditor } from "./components/TextEditor";
import { Toolbar } from "./components/Toolbar";
import { GridIcon } from "./components/icons";
import { addFavorite, loadFavorites, moveFavorite, saveFavorites } from "./favorites";
import { formatSize } from "./format";
import * as ipc from "./ipc";
import { contentTerms, prepareSearch, search, type SearchKind, type SearchRecord } from "./search";
import { TreeStore, type Row } from "./store/tree";
import { applyTint, hasSystemAccent, loadTint, saveTint, watchTint, type Tint } from "./tint";
import type { ContentSearch, Entry, Favorite, NearbyEntry, NearbySearch, Place, WorktreeInfo } from "./types";

const store = new TreeStore();
const isAndroid = /Android/i.test(navigator.userAgent);

/** How long a type-to-jump buffer stays alive between keystrokes. */
const TYPE_AHEAD_MS = 900;
const MAX_CONTENT_FILE_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set(
  "txt md mdx markdown json jsonc yaml yml toml xml html htm css scss sass less js jsx mjs cjs ts tsx rs go py rb java kt kts swift c h cc cpp hpp cs sh bash zsh fish sql graphql gql vue svelte astro ini cfg conf env lock gitignore dockerfile makefile gradle properties csv tsv log".split(
    " "
  )
);

/** What the user currently has selected, in whichever view is showing. */
interface Target {
  id: string;
  path: string;
  name: string;
  isDir: boolean;
  entry?: Entry;
}

interface EditorState {
  path?: string;
  text: string;
}

type GridSearchValue = { kind: "entry"; entry: Entry } | { kind: "worktree"; worktree: WorktreeInfo };
type NearbyState = { query: string; root: string; result: NearbySearch };
type ContentState = { query: string; root: string; result: ContentSearch };

export default function App() {
  useSyncExternalStore(store.subscribe, store.getSnapshot);

  const [places, setPlaces] = useState<Place[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>(loadFavorites);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [revealSelection, setRevealSelection] = useState(0);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [nearby, setNearby] = useState<NearbyState | null>(null);
  const [nearbyBusy, setNearbyBusy] = useState(false);
  const [content, setContent] = useState<ContentState | null>(null);
  const [contentBusy, setContentBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [quickLook, setQuickLook] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedDirCount, setSelectedDirCount] = useState<number | null | undefined>(undefined);
  const [tint, setTint] = useState<Tint>(loadTint);
  const [systemTint, setSystemTint] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const anchorRef = useRef<string | null>(null);
  const typeAhead = useRef({ buffer: "", at: 0 });
  const editorActive = useRef(false);
  editorActive.current = !!editor;

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

  useEffect(() => saveFavorites(favorites), [favorites]);

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

  const entries = store.entries;
  const worktrees = store.worktrees;
  const rows = store.rows;
  const searching = filter.trim().length > 0;
  const contentQuery = useMemo(() => contentTerms(filter), [filter]);
  // Cap this payload before it crosses IPC; the Rust side independently keeps
  // the same file/byte budgets in case a caller bypasses the renderer.
  const contentNames = useMemo(
    () => entries.filter(isContentCandidate).slice(0, 512).map((entry) => entry.name),
    [entries]
  );

  // Search records are prepared only when Fiddler's listing changes. Querying
  // these records is metadata-only and does no work outside the renderer.
  const gridRecords = useMemo<SearchRecord<GridSearchValue>[]>(
    () => [
      ...entries.map((entry) =>
        prepareSearch<GridSearchValue>({
          value: { kind: "entry", entry },
          name: entry.name,
          path: entry.path,
          searchPath: relativeSearchPath(entry.path, store.path),
          kind: entryKind(entry),
        })
      ),
      ...worktrees.map((worktree) =>
        prepareSearch<GridSearchValue>({
          value: { kind: "worktree", worktree },
          name: worktree.name,
          path: worktree.path,
          searchPath: relativeSearchPath(worktree.path, store.path),
          kind: "worktree",
        })
      ),
    ],
    [entries, worktrees, store.path]
  );
  const gridMatches = useMemo(() => (searching ? search(gridRecords, filter) : []), [searching, gridRecords, filter]);
  const localSearchEmpty = searching && gridMatches.length === 0;

  // Local search is always instant. Only a settled zero-result query gets this
  // bounded fallback; stale replies are ignored when the query or folder moves.
  useEffect(() => {
    if (!localSearchEmpty || !store.path) {
      setNearby(null);
      setNearbyBusy(false);
      return;
    }

    let live = true;
    setNearby(null);
    setNearbyBusy(true);
    const root = store.path;
    const timer = window.setTimeout(() => {
      void ipc
        .nearbyEntries(root, store.showHidden)
        .then((result) => {
          if (live) setNearby({ query: filter, root, result });
        })
        .catch(() => {
          // A permission error on a child must not replace the useful empty
          // state for the folder the user is actually viewing.
        })
        .finally(() => {
          if (live) setNearbyBusy(false);
        });
    }, 140);

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [localSearchEmpty, filter, store.path, store.showHidden]);

  const nearbyResult = nearby?.query === filter && nearby.root === store.path ? nearby.result : null;
  const nearbyRecords = useMemo<SearchRecord<GridSearchValue>[]>(
    () =>
      (nearbyResult?.entries ?? []).map((candidate) => {
        const entry = entryFromNearby(candidate);
        return prepareSearch<GridSearchValue>({
          value: { kind: "entry", entry },
          name: entry.name,
          path: entry.path,
          searchPath: candidate.relativePath,
          kind: entryKind(entry),
        });
      }),
    [nearbyResult]
  );
  const nearbyMatches = useMemo(() => (nearbyResult ? search(nearbyRecords, filter) : []), [nearbyResult, nearbyRecords, filter]);
  const usingNearby = localSearchEmpty && nearbyMatches.length > 0;

  // Content is a second-phase enhancement, never part of the keystroke path.
  // The request is restricted to files already listed in the visible folder.
  useEffect(() => {
    if (!searching || !store.path || contentQuery.length === 0 || contentNames.length === 0) {
      setContent(null);
      setContentBusy(false);
      return;
    }

    let live = true;
    setContent(null);
    setContentBusy(true);
    const root = store.path;
    const timer = window.setTimeout(() => {
      void ipc
        .searchContents(root, contentNames, contentQuery)
        .then((result) => {
          if (live) setContent({ query: filter, root, result });
        })
        .catch(() => {
          // A content scan is additive; never replace usable name results with
          // an error from one unreadable file.
        })
        .finally(() => {
          if (live) setContentBusy(false);
        });
    }, 180);

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [searching, filter, store.path, contentNames, contentQuery]);

  const contentResult = content?.query === filter && content.root === store.path ? content.result : null;

  const nameEntries = useMemo(
    () => {
      if (!searching) return entries;
      const matches = usingNearby ? nearbyMatches : gridMatches;
      return matches.flatMap((record) => (record.value.kind === "entry" ? [record.value.entry] : []));
    },
    [searching, usingNearby, nearbyMatches, gridMatches, entries]
  );
  const gridWorktrees = useMemo(
    () => {
      if (!searching) return worktrees;
      if (usingNearby) return [];
      return gridMatches.flatMap((record) => (record.value.kind === "worktree" ? [record.value.worktree] : []));
    },
    [searching, usingNearby, gridMatches, worktrees]
  );

  const contentEntries = useMemo(() => {
    if (!contentResult) return [];
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const alreadyShown = new Set(nameEntries.map((entry) => entry.path));
    return contentResult.hits.flatMap((hit) => {
      const entry = byName.get(hit.name);
      if (!entry || alreadyShown.has(entry.path)) return [];
      return [{ ...entry, searchLocation: `Line ${hit.line} · ${hit.snippet}` }];
    });
  }, [contentResult, entries, nameEntries]);

  const listRecords = useMemo(() => rows.flatMap((row) => searchRow(row, store.path)), [rows, store.path]);
  const nameRows = useMemo(
    () => {
      if (!searching) return rows;
      if (usingNearby) {
        return nearbyMatches.flatMap((record) =>
          record.value.kind === "entry" ? [searchEntryRow(record.value.entry)] : []
        );
      }
      return search(listRecords, filter).map((record) => record.value);
    },
    [searching, usingNearby, nearbyMatches, listRecords, filter, rows]
  );
  const listRows = useMemo(
    () => (contentEntries.length > 0 ? [...nameRows, ...contentEntries.map(searchEntryRow)] : nameRows),
    [nameRows, contentEntries]
  );

  /** Flat, ordered list of everything selectable in the current view. */
  const targets = useMemo<Target[]>(() => {
    if (store.view === "icons") {
      return [
        ...nameEntries.map((e) => ({
          id: e.path,
          path: e.path,
          name: e.name,
          isDir: e.kind === "dir" || (e.kind === "symlink" && e.linkToDir),
          entry: e,
        })),
        ...contentEntries.map((e) => ({
          id: e.path,
          path: e.path,
          name: e.name,
          isDir: false,
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
  }, [store.view, nameEntries, contentEntries, gridWorktrees, listRows]);

  const byId = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);
  const selected = useMemo(
    () => [...selection].map((id) => byId.get(id)).filter((t): t is Target => !!t),
    [selection, byId]
  );
  const selectedDirectory = selected.length === 1 && selected[0].isDir ? selected[0] : null;

  // The bottom bar describes the selection, not the directory being browsed.
  // Read the selected folder independently so that its count stays useful even
  // when that folder has not been expanded or opened yet.
  useEffect(() => {
    let alive = true;
    setSelectedDirCount(undefined);
    if (!selectedDirectory) return () => {
      alive = false;
    };

    void ipc
      .inspect(selectedDirectory.path)
      .then((info) => alive && setSelectedDirCount(info.childCount))
      .catch(() => alive && setSelectedDirCount(null));
    return () => {
      alive = false;
    };
  }, [selectedDirectory?.path]);

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

  const favorite = useCallback((item: Favorite, at?: number) => {
    setFavorites((current) => addFavorite(current, item, at));
  }, []);

  const unfavorite = useCallback((path: string) => {
    setFavorites((current) => current.filter((item) => item.path !== path));
  }, []);

  const reorderFavorite = useCallback((path: string, at: number) => {
    setFavorites((current) => moveFavorite(current, path, at));
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
        if (isAndroid && /\.apk$/i.test(t.name)) {
          await ipc.installApk(t.path);
          return;
        }
        const text = await ipc.readText(t.path, 2 * 1024 * 1024);
        if (!text.binary && !text.truncated) {
          setEditor({ path: t.path, text: text.text });
          return;
        }
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

  const newTextFile = useCallback(() => {
    if (store.path) setEditor({ text: "" });
  }, []);

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
        if (!t.isDir) items.push({ label: "Edit Text File", onPick: () => void openTarget(t) });
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
        items.push({ label: "New Text File", onPick: newTextFile });
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
    [openTarget, selected.length, trashSelected, newFolder, newTextFile]
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

  const kb = useRef({ targets, selection, moveCursor, openTarget, trashSelected, newFolder, newTextFile, go, jumpTo, quickLook });
  kb.current = { targets, selection, moveCursor, openTarget, trashSelected, newFolder, newTextFile, go, jumpTo, quickLook };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) {
        if (e.key === "Escape") (el as HTMLInputElement).blur();
        return;
      }

      const s = kb.current;
      const modifier = e.metaKey || e.ctrlKey;
      // The viewer owns the keyboard while it's up: it has already handled the
      // keys it cares about, and the rest must not reach the folder behind it.
      if (s.quickLook) return;
      // Same rule for the editor overlay. In particular, its Markdown preview
      // shortcut must not also toggle the Finder preview behind it.
      if (editorActive.current) return;
      const lead = [...s.selection].pop();
      const target = lead ? s.targets.find((t) => t.id === lead) : undefined;
      const perRow = store.view === "icons" ? iconsPerRow() : 1;

      // Android keyboards are not consistent here: modern ones use a literal
      // space, older DeX stacks use `Spacebar`, and a few only expose `code`.
      if ((e.key === " " || e.key === "Spacebar" || e.key === "Space" || e.code === "Space") && target?.entry && !modifier) {
        e.preventDefault();
        setQuickLook(true);
        return;
      }

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
          if (modifier && !e.shiftKey) {
            e.preventDefault();
            s.newTextFile();
          }
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
    if (!err) {
      if (!searching) return "This folder is empty";
      if (localSearchEmpty && nearbyBusy) return "Searching nearby folders…";
      if (contentBusy) return "Searching file contents…";
      if (localSearchEmpty && nearbyResult?.truncated) return "No matches in the first 10,000 nearby items";
      return "No matches";
    }
    return /denied|not permitted|Operation not permitted/i.test(err)
      ? isAndroid
        ? "Fiddler needs All files access to browse shared storage.\nAllow it in Android Settings, then return here."
        : "Fiddler doesn’t have permission to read this folder.\nGrant access in System Settings › Privacy & Security › Files and Folders."
      : err.replace(/^Error:\s*/, "");
  }, [store.listing, searching, localSearchEmpty, nearbyBusy, contentBusy, nearbyResult]);

  const statusText = useMemo(() => {
    if (usingNearby) {
      return `${targets.length} nearby item${targets.length === 1 ? "" : "s"} — within two levels`;
    }
    if (localSearchEmpty && nearbyBusy) return "Searching nearby folders…";
    if (selected.length === 0 && contentBusy) return "Searching file contents…";
    if (selected.length === 0 && contentEntries.length > 0) {
      return `${targets.length} items — ${contentEntries.length} content match${contentEntries.length === 1 ? "" : "es"}`;
    }
    if (selectedDirectory) {
      if (selectedDirCount === undefined) return `${selectedDirectory.name} — Loading…`;
      if (selectedDirCount === null) return selectedDirectory.name;
      return `${selectedDirectory.name} — ${selectedDirCount} item${selectedDirCount === 1 ? "" : "s"}`;
    }
    if (selected.length === 1 && selected[0].entry && !selected[0].isDir) {
      if (selected[0].entry.nearby) return selected[0].name;
      return `${selected[0].name} — ${formatSize(selected[0].entry.size, false)}`;
    }
    if (selected.length > 1) return `${selected.length} of ${targets.length} selected`;
    return `${targets.length} item${targets.length === 1 ? "" : "s"}`;
  }, [usingNearby, targets.length, localSearchEmpty, nearbyBusy, contentBusy, selected, selectedDirectory, selectedDirCount, contentEntries.length]);

  return (
    <div className="app">
      <GlyphDefs />
      <Sidebar
        places={places}
        favorites={favorites}
        current={store.path}
        onPick={(p) => void go(p)}
        onAddFavorite={favorite}
        onRemoveFavorite={unfavorite}
        onMoveFavorite={reorderFavorite}
      />

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
          onNewFile={newTextFile}
          onToggleHidden={() => void store.setShowHidden(!store.showHidden)}
          onTogglePreview={() => store.togglePreview()}
        />

        <div className="body">
          {store.view === "icons" ? (
            <IconGrid
              emptyMessage={emptyMessage}
              loaded={store.loaded}
              entries={nameEntries}
              contentEntries={contentEntries}
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
              searching={searching}
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
          <span className="status-text" title={statusText}>{statusText}</span>
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
      {editor && (
        <TextEditor
          path={editor.path}
          parent={store.path}
          initialText={editor.text}
          onClose={() => setEditor(null)}
          onCreated={(path) => {
            setSelection(new Set([path]));
            void store.navigate(store.path, false);
          }}
          onSaved={(name) => flash(`${name} saved`)}
        />
      )}
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

function entryKind(entry: Entry): SearchKind {
  return entry.kind === "dir" || (entry.kind === "symlink" && entry.linkToDir) ? "dir" : "file";
}

function isContentCandidate(entry: Entry) {
  if (entry.kind !== "file" || entry.size > MAX_CONTENT_FILE_BYTES) return false;
  const name = entry.name.toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  return TEXT_EXTENSIONS.has(extension) || ["readme", "license", "makefile", "dockerfile", ".env"].includes(name);
}

/** Nearby scans avoid metadata calls; full details arrive only if the item opens. */
function entryFromNearby(candidate: NearbyEntry): Entry {
  return {
    name: candidate.name,
    path: candidate.path,
    kind: candidate.kind,
    linkToDir: candidate.linkToDir,
    size: 0,
    mtime: 0,
    hidden: candidate.hidden,
    thumbable: false,
    isRepo: false,
    worktreeCount: 0,
    branch: null,
    code: null,
    rollup: null,
    nearby: true,
    searchLocation: candidate.relativePath,
  };
}

function searchEntryRow(entry: Entry): Row {
  const navigable = entry.kind === "dir" || (entry.kind === "symlink" && entry.linkToDir);
  return { kind: "entry", id: entry.path, depth: 0, dirPath: navigable ? entry.path : null, entry, expanded: false };
}

/** Search results are flat and ranked; the normal list remains a navigable tree. */
function searchRow(row: Row, root: string): SearchRecord<Row>[] {
  if (row.kind === "wt-group") return [];
  const value: Row = { ...row, depth: 0, expanded: false };
  if (row.kind === "entry") {
    return [
      prepareSearch<Row>({
        value,
        name: row.entry.name,
        path: row.entry.path,
        searchPath: relativeSearchPath(row.entry.path, root),
        kind: entryKind(row.entry),
      }),
    ];
  }
  return [
    prepareSearch<Row>({
      value,
      name: row.wt.name,
      path: row.wt.path,
      searchPath: relativeSearchPath(row.wt.path, root),
      kind: "worktree",
    }),
  ];
}

/** Never rank every result on a shared absolute ancestor such as `worktrees`. */
function relativeSearchPath(path: string, root: string) {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}
