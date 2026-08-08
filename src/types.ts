/** Mirrors `src-tauri/src/model.rs`. Keep the two in step. */

export type Kind = "dir" | "file" | "symlink";

/** Porcelain-v2 two-character status. `.` means "nothing on this side". */
export interface Code {
  index: string;
  worktree: string;
}

export interface Rollup {
  staged: number;
  modified: number;
  untracked: number;
  deleted: number;
  conflicted: number;
}

export interface Entry {
  name: string;
  path: string;
  kind: Kind;
  linkToDir: boolean;
  size: number;
  mtime: number;
  hidden: boolean;
  /** A preview can be produced for this file. */
  thumbable: boolean;
  isRepo: boolean;
  worktreeCount: number;
  branch: string | null;
  code: Code | null;
  rollup: Rollup | null;
}

export interface WorktreeInfo {
  id: string;
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  /** Lives outside the repo's own directory tree — the invisible ones. */
  external: boolean;
  isMain: boolean;
}

export interface DirListing {
  path: string;
  entries: Entry[];
  repoRoot: string | null;
  worktrees: WorktreeInfo[];
  statusPending: boolean;
  /** Set client-side when the directory could not be read at all. */
  error?: string;
}

export interface RepoStatusPayload {
  root: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  rollup: Rollup;
}

export interface RepoInfo {
  root: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  rollup: Rollup;
  worktrees: WorktreeInfo[];
}

export interface Place {
  name: string;
  path: string;
  icon: string;
}

export const emptyRollup: Rollup = {
  staged: 0,
  modified: 0,
  untracked: 0,
  deleted: 0,
  conflicted: 0,
};

export function rollupTotal(r: Rollup): number {
  return r.staged + r.modified + r.untracked + r.deleted + r.conflicted;
}

export interface Inspect {
  /** Leading text of a small, textual file. */
  text: string | null;
  /** Direct child count, for folders. */
  childCount: number | null;
  binary: boolean;
}
