import type { Code, Rollup } from "../types";

/**
 * Git, stated quietly: one small coloured dot. The tooltip explains it in plain
 * words, because most people opening a file browser don't think in porcelain codes.
 */

type State = "conflict" | "modified" | "staged" | "untracked" | null;

function stateOfCode(code: Code): { state: State; label: string } {
  if (code.index === "!") return { state: null, label: "Ignored" };
  if (code.index === "?") return { state: "untracked", label: "New — not yet tracked" };
  if (code.index === "u") return { state: "conflict", label: "Has a merge conflict" };

  const staged = code.index !== ".";
  const unstaged = code.worktree !== ".";
  if (code.index === "D" || code.worktree === "D") {
    return { state: "modified", label: "Deleted" };
  }
  if (staged && unstaged) return { state: "modified", label: "Edited, partly saved to git" };
  if (staged) return { state: "staged", label: "Edited and staged" };
  return { state: "modified", label: "Edited" };
}

function stateOfRollup(r: Rollup): { state: State; label: string } {
  const total = r.staged + r.modified + r.untracked + r.deleted + r.conflicted;
  if (total === 0) return { state: null, label: "" };

  const bits: string[] = [];
  if (r.conflicted) bits.push(`${r.conflicted} conflicted`);
  if (r.modified) bits.push(`${r.modified} edited`);
  if (r.staged) bits.push(`${r.staged} staged`);
  if (r.deleted) bits.push(`${r.deleted} deleted`);
  if (r.untracked) bits.push(`${r.untracked} new`);

  const state: State = r.conflicted
    ? "conflict"
    : r.modified || r.deleted
      ? "modified"
      : r.staged
        ? "staged"
        : "untracked";

  return { state, label: `Inside: ${bits.join(", ")}` };
}

interface Props {
  code?: Code | null;
  rollup?: Rollup | null;
  /** Show the number of changed things — list view only, where there's room. */
  withCount?: boolean;
}

export function GitDot({ code, rollup, withCount }: Props) {
  const resolved = code ? stateOfCode(code) : rollup ? stateOfRollup(rollup) : null;
  if (!resolved || !resolved.state) return null;

  const count =
    withCount && rollup
      ? rollup.staged + rollup.modified + rollup.untracked + rollup.deleted + rollup.conflicted
      : 0;

  return (
    <span className={`gitdot ${resolved.state}`} title={resolved.label}>
      <i />
      {count > 1 && <b>{count}</b>}
    </span>
  );
}
