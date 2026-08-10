/** Dragging items somewhere else — the gesture a file manager is mostly for.
 *
 * Two things live here. The first is the payload: a drag carries a list of
 * paths, and it carries them in module state as well as in the `DataTransfer`,
 * because `getData` is deliberately blank during `dragover`. A drop target has
 * to decide whether it will accept a drag *while the drag is over it*, which
 * means it can read the types but not the contents — so the only way to refuse
 * dropping a folder into itself is to have kept the payload here.
 *
 * The second is `dropPlan`, which is where every rule about what a drop means
 * lives: copy or move, and whether the drop makes sense at all.
 *
 * Copy is the default and a held ⌘ or ⌥ asks for a move, which is the opposite
 * of Finder. It is deliberate: nothing should leave the place a person put it
 * because a pointer wobbled onto the wrong folder on the way past. The verb is
 * shown on the target before the button comes up, so the choice is never a
 * guess. `endItemDrag` clears the payload — every drag source must call it on
 * `dragend`, which fires whether the drop landed or not.
 */

import { locationCaps } from "./location.ts";

/** Keeps an item drag distinct from the folder-to-Favorites drag, from a
 * column reorder, and from ordinary text. */
export const ITEM_DRAG_TYPE = "application/x-fiddler-items";

export type DropVerb = "copy" | "move";

export interface DragItems {
  paths: string[];
  /** For the count and the wording. The paths are what actually moves. */
  names: string[];
}

let active: DragItems | null = null;

export function beginItemDrag(items: DragItems) {
  active = items;
}

/** The drag in flight, or null. Readable during `dragover`, which is the point. */
export function currentItemDrag(): DragItems | null {
  return active;
}

export function endItemDrag() {
  active = null;
}

/** Is this pointer asking for a move rather than the default copy? */
export function wantsMove(event: { metaKey: boolean; altKey: boolean }): boolean {
  return event.metaKey || event.altKey;
}

/** The folder a path sits in, for the three address spaces Fiddler browses.
 * Only ever compared for equality, so the answer at a root doesn't have to be
 * meaningful — it only has to not accidentally equal a real folder. */
export function parentOf(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/");
  if (cut < 0) return "";
  const parent = trimmed.slice(0, cut);
  // `mtp://serial` cut again would give `mtp:/`, which is nobody's folder.
  return parent.endsWith(":/") || parent.endsWith("://") ? "" : parent;
}

/**
 * What dropping `paths` onto `destination` would do — or null when it would do
 * nothing worth offering, in which case the target should refuse the drag
 * rather than accept it and then complain.
 *
 * Four ways a drop is refused: the destination can't be written to, a source
 * can't be read from, an item is being dropped into itself, or it is already
 * there. The last is the reason a breadcrumb doesn't light up for the folder
 * you are standing in.
 */
export function dropPlan(paths: string[], destination: string, move: boolean): DropVerb | null {
  if (paths.length === 0 || !destination) return null;

  const into = locationCaps(destination);
  if (!into.paste) return null;
  // A device takes a paste but cannot be made to hold a new entry under a name
  // of our choosing, so an upload there is a copy however it was asked for.
  let movable = into.create;

  for (const path of paths) {
    if (!path) return null;
    if (path === destination || destination.startsWith(path + "/")) return null;
    if (parentOf(path) === destination) return null;
    const from = locationCaps(path);
    if (!from.copy) return null;
    if (!from.modify) movable = false;
  }

  return move && movable ? "move" : "copy";
}

/** "3 items", "notes.md" — what a toast says about a drop that just landed. */
export function describeItems(items: DragItems): string {
  return items.names.length === 1 ? `“${items.names[0]}”` : `${items.names.length} items`;
}
