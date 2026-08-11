/**
 * The two views are virtualized, so the item holding the keyboard cursor can be
 * unmounted by a scroll. `aria-activedescendant` survives that where a roving
 * `tabIndex` doesn't: the scroller keeps focus and only points at the lead item.
 * Pointing means referencing it by DOM id, and an item's id here is its path —
 * which routinely contains spaces, and a space ends the reference.
 *
 * Encoding is what keeps this a pure function of the path. The alternative, a
 * map from item to generated id, is one more thing to keep in step with a list
 * that changes on every listing.
 */
export function itemDomId(prefix: string, id: string): string {
  return `${prefix}-${encodeURIComponent(id)}`;
}
