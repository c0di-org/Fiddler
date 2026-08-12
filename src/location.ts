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
 * hiding "Move to Trash" while ⌘⌫ still fires would only move the confusion.
 *
 * A read-only volume is the fourth thing these menus have to ask about, and it
 * is deliberately not a fourth address space — see `readOnlyVolume` below. */

import type { Volume } from "./types";
import { volumeFor } from "./volumes.ts";

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
  /** The name of the read-only volume this path is on, when it is on one.
   *
   * A fourth address space would have been the wrong shape. The three above are
   * properties of the *path* — you can tell them apart by looking at the string
   * — and read-only is a property of the *disk*, which the same path had and
   * then didn't when someone flipped the lock tab on a card and remounted it.
   * So it is a flag, resolved by asking which volume the path is on.
   *
   * It also has to be told apart from the three above when phrasing a refusal:
   * "not yet" is the truth for a phone on a cable and a lie about a read-only
   * disk, where the answer is not that Fiddler hasn't learned to write, it is
   * that the kernel will refuse. See `refusal`. */
  readOnlyVolume: string | null;
}

const LOCAL: LocationCaps = {
  paste: true,
  create: true,
  modify: true,
  copy: true,
  shell: true,
  where: null,
  readOnlyVolume: null,
};

/**
 * What can be done in a place.
 *
 * `volumes` is optional, and the default is not laziness: only the handful of
 * call sites standing in a real folder have a volume list to hand, and a path
 * in one of the two device address spaces is never on a volume anyway. Passing
 * nothing means "no volume is read-only", which is right for every path on the
 * startup disk — which is all of them, on a machine with nothing plugged in.
 */
export function locationCaps(path: string, volumes: Volume[] = []): LocationCaps {
  switch (spaceOf(path)) {
    case "device":
      return {
        paste: true,
        create: false,
        modify: false,
        copy: false,
        shell: false,
        where: "a device on a cable",
        readOnlyVolume: null,
      };
    case "nearby":
      return {
        paste: false,
        create: false,
        modify: false,
        copy: true,
        shell: false,
        where: "a device over Wi-Fi",
        readOnlyVolume: null,
      };
    default: {
      const volume = volumeFor(path, volumes);
      if (!volume?.readOnly) return LOCAL;
      return {
        // Everything that would write is refused here rather than attempted,
        // because the kernel refuses it anyway and an error from `std::fs` is
        // a worse way to find out. Reading is untouched: the whole point of a
        // read-only disk is that you can still take things off it, and Finder
        // and Terminal are as happy with it as ever.
        paste: false,
        create: false,
        modify: false,
        copy: true,
        shell: true,
        where: volume.name,
        readOnlyVolume: volume.name,
      };
    }
  }
}

/**
 * The sentence to show when one of the write capabilities above is false.
 *
 * Two different facts wear the same shape, and saying the wrong one is worse
 * than saying nothing. "Fiddler can't rename items on a device on a cable yet"
 * is a promise about Fiddler: MTP has a rename and this app hasn't called it.
 * "ReadOnlyDisk is read-only" is a fact about the disk, and no future version
 * of Fiddler will change it — so it does not get a "yet".
 *
 * `action` is the bare verb phrase: "create folders", "rename items".
 */
export function refusal(caps: LocationCaps, action: string): string {
  if (caps.readOnlyVolume) {
    return `${caps.readOnlyVolume} is read-only — Fiddler can’t ${action} there`;
  }
  return `Fiddler can’t ${action} on ${caps.where} yet`;
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

export function transferNote(path: string, volumes: Volume[] = []): TransferNote | null {
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
    default: {
      // The third case, and the only one that isn't about a missing feature.
      // Worth the same banner because it is the same surprise: a folder full of
      // files that look every bit as draggable as any other, in a window that
      // will refuse the drop.
      const volume = volumeFor(path, volumes);
      if (!volume?.readOnly) return null;
      return {
        title: `${volume.name} is read-only`,
        detail:
          "Items can be copied off it, and nothing here can be changed, added or deleted. That's the disk refusing rather than Fiddler — a disk image attached read-only, or a card with its lock switch across, behaves this way everywhere.",
      };
    }
  }
}
