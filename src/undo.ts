/** ⌘Z, and the small amount of bookkeeping it takes.
 *
 * Four operations are recorded: a rename, a paste, a drag, and a trip to the
 * Trash. Each one is remembered as what it *did*, not as a closure that knows
 * how to walk itself back — so the walking back lives in `invert`, which is a
 * pure function from an entry to a list of steps, and can be read and tested
 * without a filesystem anywhere near it. The caller runs the steps.
 *
 * The stack is in memory and ends with the process, which is what Finder does
 * and what people expect: nobody quits, reopens, and reaches for ⌘Z to walk
 * back yesterday's rename. It holds the last few operations rather than
 * everything, because a stack deep enough to reach a mistake made an hour ago
 * is also deep enough to undo something you have since come to rely on.
 *
 * An undo that fails is dropped rather than kept: the usual reason a restore
 * can't happen is that something else has taken the name, and that is not a
 * condition ⌘Z pressed a second time will improve.
 */

import { parentOf } from "./drag.ts";
import type { Trashed } from "./types.ts";

/** How deep ⌘Z goes. */
export const UNDO_LIMIT = 20;

export type UndoAction =
  /** `to` is where the item ended up; `from` is what it was called before. */
  | { kind: "rename"; from: string; to: string }
  /** Items that did not exist before. Undoing means taking them away again. */
  | { kind: "create"; paths: string[] }
  /** Where each item went, and where it came from. */
  | { kind: "move"; moves: { from: string; to: string }[] }
  | { kind: "trash"; items: Trashed[] };

export interface UndoEntry {
  /** What the menu and the toast call it: "Rename", "Move", "Move to Trash". */
  label: string;
  action: UndoAction;
}

/** A step the caller performs. Deliberately data rather than a function, so the
 * decision about what undoing means stays testable. */
export type UndoStep =
  | { do: "rename"; path: string; name: string }
  | { do: "trash"; paths: string[] }
  | { do: "move"; paths: string[]; into: string }
  | { do: "restore"; items: Trashed[] };

/**
 * What it would take to walk `entry` back.
 *
 * The only interesting case is a move, because one drag can gather items from
 * several folders — a search listing spans the whole tree — and each one has to
 * go back to its own. Grouping by origin is what turns that into one call per
 * folder instead of one per item.
 */
export function invert(entry: UndoEntry): UndoStep[] {
  const action = entry.action;
  switch (action.kind) {
    case "rename":
      return [{ do: "rename", path: action.to, name: basename(action.from) }];
    case "create":
      // To the Trash, not deleted: undoing a paste must not be the one action
      // in Fiddler that destroys something outright.
      return action.paths.length > 0 ? [{ do: "trash", paths: action.paths }] : [];
    case "move": {
      const home = new Map<string, string[]>();
      for (const { from, to } of action.moves) {
        const into = parentOf(from);
        const group = home.get(into);
        if (group) group.push(to);
        else home.set(into, [to]);
      }
      return [...home].map(([into, paths]) => ({ do: "move", paths, into }));
    }
    case "trash":
      return action.items.length > 0 ? [{ do: "restore", items: action.items }] : [];
  }
}

function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

// ------------------------------------------------------------------ the stack

let stack: UndoEntry[] = [];
const listeners = new Set<() => void>();

function announce() {
  for (const listener of listeners) listener();
}

/** Shaped for `useSyncExternalStore`: the snapshot is the array itself, whose
 * identity only changes when the stack does. */
export const undoStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  getSnapshot(): UndoEntry[] {
    return stack;
  },
};

export function remember(entry: UndoEntry) {
  stack = [...stack, entry].slice(-UNDO_LIMIT);
  announce();
}

/** The operation ⌘Z would walk back, without taking it off the stack. */
export function pending(): UndoEntry | null {
  return stack[stack.length - 1] ?? null;
}

/** Take the top entry. It is gone whether the undo then succeeds or not. */
export function take(): UndoEntry | null {
  const entry = stack[stack.length - 1];
  if (!entry) return null;
  stack = stack.slice(0, -1);
  announce();
  return entry;
}

/** Only for tests, which would otherwise inherit each other's stacks. */
export function forgetAll() {
  stack = [];
  announce();
}
