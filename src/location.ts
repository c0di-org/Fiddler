/** What a *place* can do, as opposed to what the build can do.
 *
 * `caps` in `platform.ts` answers "does this build have a Finder to reveal
 * into". This answers a different question that the same menus have to ask:
 * "does this folder have a filesystem behind it at all".
 *
 * Fiddler browses three address spaces. A real path is the only one the
 * backend's mutating commands understand — `create_folder`, `create_text_file`,
 * `rename_path` and `trash_paths` are plain `std::fs` calls, so handing one an
 * `mtp://` string produces an OS error about a missing file called `mtp:`
 * rather than anything a person can act on. `copy_paths` knows how to download
 * from a nearby Fiddler but has no MTP source and no remote destination.
 *
 * Offering a menu item that cannot work is worse than leaving it out, so the
 * menus ask here first — and the keyboard shortcuts behind them ask too, since
 * hiding "Move to Trash" while ⌘⌫ still fires would only move the confusion. */

/** Which address space a path belongs to. */
type Space = "local" | "nearby" | "device";

function spaceOf(path: string): Space {
  if (path.startsWith("mtp://")) return "device";
  if (path.startsWith("fiddler://")) return "nearby";
  return "local";
}

export interface LocationCaps {
  /** Items can be created here: New Folder, New Text File, Paste — and the
   * things already here can be renamed or moved to the Trash. */
  write: boolean;
  /** Items here can be copied somewhere else. */
  copy: boolean;
  /** The OS shell understands this path: Reveal in Finder, Open in Terminal. */
  shell: boolean;
  /** How to name this place mid-sentence, or null when it's the local disk.
   * The refusals are worth phrasing, because "not yet" is the honest answer:
   * MTP has a create-folder and an upload, and nothing here calls them. */
  where: string | null;
}

const LOCAL: LocationCaps = { write: true, copy: true, shell: true, where: null };

export function locationCaps(path: string): LocationCaps {
  switch (spaceOf(path)) {
    case "device":
      return { write: false, copy: false, shell: false, where: "a connected device" };
    case "nearby":
      return { write: false, copy: true, shell: false, where: "a nearby device" };
    default:
      return LOCAL;
  }
}
