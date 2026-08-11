/** What a *place* can do, as opposed to what the build can do.
 *
 * `caps` in `platform.ts` answers "does this build have a Finder to reveal
 * into". This answers a different question that the same menus have to ask:
 * "does this folder have a filesystem behind it at all".
 *
 * Fiddler browses three address spaces, and a real path is the only one the
 * backend's mutating commands understand — `create_folder`, `create_text_file`,
 * `rename_path` and `trash_paths` are plain `std::fs` calls, so handing one an
 * `mtp://` string produces an OS error about a missing file called `mtp:`
 * rather than anything a person can act on.
 *
 * The exception is what the cable has actually been taught. `copy_paths` grew
 * an MTP destination, so a device can be pasted onto even though nothing else
 * can be made there; it has no MTP *source* yet, so a file cannot be copied
 * back off one. Hence three separate answers rather than one "writable" — they
 * really are three different states of the backend.
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
  /** Items copied from elsewhere can be put here: Paste. */
  paste: boolean;
  /** Items can be made here from nothing: New Folder, New Text File. */
  create: boolean;
  /** What's already here can be renamed, or moved to the Trash. */
  modify: boolean;
  /** Items here can be copied somewhere else. */
  copy: boolean;
  /** The OS shell understands this path: Reveal in Finder, Open in Terminal. */
  shell: boolean;
  /** How to name this place mid-sentence, or null when it's the local disk.
   * The refusals are worth phrasing, because "not yet" is the honest answer:
   * MTP has a create-folder and a delete, and nothing here calls them. */
  where: string | null;
}

const LOCAL: LocationCaps = {
  paste: true,
  create: true,
  modify: true,
  copy: true,
  shell: true,
  where: null,
};

export function locationCaps(path: string): LocationCaps {
  switch (spaceOf(path)) {
    case "device":
      return {
        paste: true,
        create: false,
        modify: false,
        copy: false,
        shell: false,
        where: "a device on a cable",
      };
    case "nearby":
      return {
        paste: false,
        create: false,
        modify: false,
        copy: true,
        shell: false,
        where: "a device over Wi-Fi",
      };
    default:
      return LOCAL;
  }
}

/**
 * Which way files can travel here, said before anyone tries it.
 *
 * The two device spaces are exact inverses of one another — a cable takes a
 * paste and gives nothing back, a nearby device gives and takes nothing — and
 * there is no way to guess which one you are standing in by looking at it. The
 * rows in the sidebar are the same shape, and both places list files that look
 * every bit as draggable as a local folder.
 *
 * Fiddler already says all of this, but only *after* the attempt, as a toast
 * (see the refusals in `App.tsx`). Telling someone that the drag they just made
 * was never going to work is a worse answer than telling them beforehand, so
 * this is the same fact moved to the front.
 */
export interface TransferNote {
  title: string;
  detail: string;
}

export function transferNote(path: string): TransferNote | null {
  switch (spaceOf(path)) {
    case "device":
      return {
        title: "Files can go onto this device, not off it",
        detail:
          "Drag or paste items here and they copy across the cable. Taking them back off — and renaming or deleting what's already here — isn't supported yet.",
      };
    case "nearby":
      return {
        title: "Files can come off this device, not onto it",
        detail:
          "Drag or copy items from here to a folder of your own. Putting items onto it, and changing what's there, isn't supported yet.",
      };
    default:
      return null;
  }
}
