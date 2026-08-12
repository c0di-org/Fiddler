/** What to say about a mounted volume, and which volume a path is on.
 *
 * The sibling of `usb.ts`: the backend reports facts, and everything a person
 * reads is decided here, in one place, testable without a disk. */

import { permissionHelp } from "./platform.ts";
import type { EjectOutcome, Volume } from "./types";
// The same `Notice` a phone on a cable produces, so a volume that isn't
// readable yet and a phone that isn't unlocked yet are drawn by the same code.
import type { Notice } from "./usb";

/**
 * The volume a path is on, or null for a path on the startup disk.
 *
 * Longest mount point wins, because mounts nest: a card mounted inside a folder
 * on an external drive is a real thing, and the shorter match would answer for
 * the wrong disk. The boundary check matters as much as the prefix — without
 * it, `/Volumes/Archive2` reads as being on `/Volumes/Archive`, which would
 * hand it another disk's read-only flag.
 */
export function volumeFor(path: string, volumes: Volume[]): Volume | null {
  let best: Volume | null = null;
  for (const volume of volumes) {
    if (!within(path, volume.path)) continue;
    if (!best || volume.path.length > best.path.length) best = volume;
  }
  return best;
}

/** Is `path` the mount point itself, or something inside it? */
function within(path: string, mount: string): boolean {
  if (path === mount) return true;
  const root = mount.endsWith("/") ? mount : `${mount}/`;
  return path.startsWith(root);
}

/**
 * What to say about a volume that is mounted but can't be read.
 *
 * The same shape of answer as `connectionNotice` for a phone, and for the same
 * reason: the disk is plainly there, so "no such folder" would be a lie and
 * hiding it would leave someone comparing Fiddler against Finder and finding
 * Fiddler wrong. `permissionHelp` already knows where each platform fixes this.
 */
export function volumeNotice(volume: Volume): Notice | null {
  switch (volume.stage) {
    case "ready":
      return null;
    case "locked":
      return {
        title: `Fiddler can’t read ${volume.name} yet`,
        detail: permissionHelp(),
        // Granting the permission is what clears it, and the volume list is
        // re-read when it does.
        resolves: true,
      };
    case "unreadable":
      return {
        title: `Couldn’t read ${volume.name}`,
        detail: volume.message,
        resolves: false,
      };
  }
}

/**
 * What to say about a volume that refused to be ejected.
 *
 * States what happened, names who caused it, and says what has *not* happened —
 * that last part is the one people need, because the disk is still mounted and
 * still safe, and an eject that quietly did nothing is indistinguishable from
 * one that half worked.
 *
 * It never suggests quitting anything on the person's behalf. `mtp`'s
 * `Stage::Blocked` does offer that, and the difference is what is at stake:
 * there the holder is `ptpcamerad`, a daemon that respawns and owns no
 * document. Here it is whatever the person is working in, and killing an editor
 * with unsaved work to hurry an eject along is not a trade Fiddler gets to make.
 */
export function ejectNotice(volume: Volume, outcome: EjectOutcome): Notice | null {
  if (outcome.outcome === "ejected") return null;
  const names = [...new Set(outcome.holders.map((holder) => holder.name))];
  return {
    title: names.length
      ? `${list(names)} ${names.length === 1 ? "is" : "are"} still using ${volume.name}`
      : `Something is still using ${volume.name}`,
    detail: names.length
      ? `${volume.name} is still mounted and nothing has changed on it. Close what you have open there and try again — or eject anyway, which stops ${names.length === 1 ? "it" : "them"} mid-write.`
      : `${volume.name} is still mounted and nothing has changed on it. macOS didn’t say what is holding it. Closing anything you have open on the disk and trying again usually clears it.`,
    resolves: false,
  };
}

/** "Preview", "Preview and zsh", "Preview, zsh and Finder". */
function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
