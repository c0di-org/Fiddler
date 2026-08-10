import { useCallback, useState } from "react";

import { currentItemDrag, dropPlan, wantsMove, type DragItems, type DropVerb } from "../drag.ts";

/**
 * A folder that a drag can land in: a grid cell, a list row, a sidebar place, a
 * breadcrumb. Four surfaces that look nothing alike but have to answer exactly
 * the same question, so the question is asked in one place.
 *
 * `verb` is what the drop would do right now, and it changes as ⌘ or ⌥ goes
 * down mid-drag — which is why it comes back as state rather than being read at
 * drop time. Rendering it on the target is the whole point: the choice between
 * copying and moving should be visible before the button comes up, not
 * discovered afterwards.
 *
 * Null `destination` disables the target completely — a file row, or the
 * breadcrumb's "…" — and the handlers become cheap no-ops rather than a
 * conditional at every call site.
 */
export interface DropTarget {
  verb: DropVerb | null;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}

export type DropItems = (destination: string, verb: DropVerb, items: DragItems) => void;

export function useDropTarget(destination: string | null, onDropItems?: DropItems): DropTarget {
  const [verb, setVerb] = useState<DropVerb | null>(null);

  const onDragOver = useCallback(
    (event: React.DragEvent) => {
      const items = currentItemDrag();
      if (!items || !destination || !onDropItems) return;
      const plan = dropPlan(items.paths, destination, wantsMove(event));
      if (!plan) {
        // Left un-prevented on purpose: an unaccepted target shows the OS "no"
        // cursor, which says more than a highlight that does nothing.
        if (verb) setVerb(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = plan;
      if (plan !== verb) setVerb(plan);
    },
    [destination, onDropItems, verb],
  );

  const onDragLeave = useCallback((event: React.DragEvent) => {
    // Crossing into a child fires a leave for the parent; only a pointer that
    // has actually left ends the highlight.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setVerb(null);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      const items = currentItemDrag();
      setVerb(null);
      if (!items || !destination || !onDropItems) return;
      const plan = dropPlan(items.paths, destination, wantsMove(event));
      if (!plan) return;
      event.preventDefault();
      event.stopPropagation();
      onDropItems(destination, plan, items);
    },
    [destination, onDropItems],
  );

  return { verb, onDragOver, onDragLeave, onDrop };
}

/** The attributes a drop target renders. Kept next to the hook so the class and
 * the attribute the CSS reads can never drift apart. */
export function dropProps(target: DropTarget) {
  return {
    className: target.verb ? "drop-into" : "",
    "data-drop-verb": target.verb === "move" ? "Move" : target.verb === "copy" ? "Copy" : undefined,
    onDragOver: target.onDragOver,
    onDragLeave: target.onDragLeave,
    onDrop: target.onDrop,
  };
}
