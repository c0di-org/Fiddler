/** What's mounted, and how things get mounted.
 *
 * A web Fiddler starts with one location — the demo tree — and gains more as
 * the user offers them: a folder picked through the File System Access API, or
 * anything dragged onto the window. Nothing is ever reached for on its own. */

import type { Place } from "../../types";
import { buildDemo, DEMO_MOUNT } from "./demo";
import { buildPeer, buildPhone, PEER_ID, PEER_NAME, PHONE_NAME, PHONE_SERIAL } from "./demo-device";
import { LocalProvider, pickDirectory } from "./local-fs";
import { MemoryProvider } from "./memory-fs";
import { addMount, allMounts, joinSegments, mountExists, uniqueMountId } from "./vfs";

const DROPPED_MOUNT = "Dropped Files";

let dropped: MemoryProvider | null = null;

export function initMounts() {
  if (mountExists(DEMO_MOUNT)) return;
  addMount({
    id: DEMO_MOUNT,
    name: DEMO_MOUNT,
    icon: "code",
    listed: true,
    provider: buildDemo(),
  });

  // The two simulated devices. Their mount ids *are* their addresses — see the
  // scheme handling in `vfs.segments` — so `mtp://R5CW42XKPNZ/65537/DCIM`
  // resolves here exactly the way `/Fiddler Demo/Pictures` does.
  //
  // `listed: false` because neither belongs in Places: a device appears in its
  // own section of the sidebar, drawn from `usbDevices` and `nearbyDevices`,
  // and listing it twice would suggest they were two different things.
  addMount({
    id: `mtp://${PHONE_SERIAL}`,
    name: PHONE_NAME,
    icon: "folder",
    listed: false,
    provider: buildPhone(),
  });
  addMount({
    id: `fiddler://${PEER_ID}`,
    name: PEER_NAME,
    icon: "folder",
    listed: false,
    provider: buildPeer(),
  });
}

export function places(): Place[] {
  return allMounts()
    .filter((mount) => mount.listed)
    .map((mount) => ({ name: mount.name, path: joinSegments([mount.id]), icon: mount.icon }));
}

// ------------------------------------------------------------ real folders

/** Mounts a folder the user picked. Resolves to the path to navigate to, or
 * null when they cancelled — a cancelled picker is not an error to report. */
export async function openFolder(): Promise<string | null> {
  let handle;
  try {
    handle = await pickDirectory();
  } catch (err) {
    // The picker rejects with AbortError on cancel, which is a normal outcome
    // and must not surface as a failure toast.
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }

  const provider = new LocalProvider(handle);
  const id = uniqueMountId(provider.rootName || "Folder");
  addMount({ id, name: id, icon: "folder", listed: true, provider });
  return joinSegments([id]);
}

// --------------------------------------------------------------- drop-in

/** Absorbs a drop. Called straight from the event handler, and deliberately not
 * `async`: `getAsFileSystemHandle` and `webkitGetAsEntry` are only valid while
 * the original event is still being dispatched, so the items have to be claimed
 * before anything yields. */
export function importDropped(transfer: DataTransfer): Promise<string | null> {
  const claimed = [...transfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => ({
      handle: asHandle(item),
      entry: asEntry(item),
    }));
  return absorb(claimed);
}

interface ClaimedItem {
  handle: Promise<unknown> | null;
  entry: FsEntry | null;
}

async function absorb(items: ClaimedItem[]): Promise<string | null> {
  if (items.length === 0) return null;
  let target: string | null = null;

  for (const item of items) {
    // Chromium hands over a real handle, which means a dropped folder is as
    // live as a picked one — writes included. Everywhere else we fall back to
    // copying the bytes into the tab.
    const handle = item.handle ? await item.handle.catch(() => null) : null;
    if (isDirectoryHandle(handle)) {
      const provider = new LocalProvider(handle);
      const id = uniqueMountId(provider.rootName || "Folder");
      addMount({ id, name: id, icon: "folder", listed: true, provider });
      target = joinSegments([id]);
      continue;
    }
    if (item.entry) {
      await copyEntry(item.entry, "");
      target = joinSegments([DROPPED_MOUNT]);
    }
  }

  return target;
}

function dropMount(): MemoryProvider {
  if (dropped) return dropped;
  dropped = new MemoryProvider();
  addMount({
    id: DROPPED_MOUNT,
    name: DROPPED_MOUNT,
    icon: "download",
    listed: true,
    provider: dropped,
  });
  return dropped;
}

/** Guards against a drop of a whole disk turning into an out-of-memory crash.
 * Anything past the budget is skipped rather than truncated, so a file that is
 * present is always whole. */
const DROP_BUDGET = 256 * 1024 * 1024;
let droppedBytes = 0;

async function copyEntry(entry: FsEntry, prefix: string): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      entry.file?.(resolve, () => resolve(null))
    );
    if (!file || droppedBytes + file.size > DROP_BUDGET) return;
    droppedBytes += file.size;
    dropMount().seedFile(path, file, Math.floor(file.lastModified / 1000));
    return;
  }

  if (!entry.isDirectory || !entry.createReader) return;
  dropMount().seedDir(path);
  const reader = entry.createReader();
  // `readEntries` returns a page at a time and signals the end with an empty
  // batch; a single call would quietly take only the first hundred children.
  for (;;) {
    const batch = await new Promise<FsEntry[]>((resolve) =>
      reader.readEntries(resolve, () => resolve([]))
    );
    if (batch.length === 0) break;
    for (const child of batch) await copyEntry(child, path);
  }
}

// --------------------------------------------------------- item shim types

interface FsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?(onSuccess: (file: File) => void, onError: () => void): void;
  createReader?(): { readEntries(onSuccess: (entries: FsEntry[]) => void, onError: () => void): void };
}

interface DroppedItem {
  getAsFileSystemHandle?(): Promise<unknown>;
  webkitGetAsEntry?(): FsEntry | null;
}

function asHandle(item: DataTransferItem): Promise<unknown> | null {
  const shim = item as unknown as DroppedItem;
  return typeof shim.getAsFileSystemHandle === "function" ? shim.getAsFileSystemHandle() : null;
}

function asEntry(item: DataTransferItem): FsEntry | null {
  const shim = item as unknown as DroppedItem;
  return typeof shim.webkitGetAsEntry === "function" ? shim.webkitGetAsEntry() : null;
}

function isDirectoryHandle(value: unknown): value is ConstructorParameters<typeof LocalProvider>[0] {
  return !!value && typeof value === "object" && (value as { kind?: string }).kind === "directory";
}
