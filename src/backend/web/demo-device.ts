/** The two devices the web build pretends to have, and the trees behind them.
 *
 * Fiddler's rule everywhere else is that the browser build does not fake what
 * it cannot do — `web.ts` returns no git status rather than invented dots,
 * because a file browser showing made-up state is one you cannot trust the rest
 * of. These devices are the deliberate exception, and they are only defensible
 * because they are *labelled*: every row carries a `demo` tag (see `simulated`
 * in `Sidebar.tsx`), and `Devices.md` in the demo tree says plainly which parts
 * are real and which are theatre.
 *
 * The reasoning: a cable and a Wi-Fi transport are two of the three things
 * Fiddler does that a Finder does not, and a screenshot of them convinces
 * nobody. Faking a git dot would mislead someone about *their own files*, which
 * is a different and much worse thing than showing a phone that says it is a
 * demonstration on the row you clicked.
 *
 * Everything here is content, not behaviour: the stage machine, the pairing
 * handshake and the access bookkeeping all live in `web.ts`, driving the same
 * interface the Rust backend implements.
 */

import type { Entry, PeerDevice, UsbDevice, UsbStorage } from "../../types";
import { PALETTES, wallpaper } from "./demo-art";
import { MemoryProvider } from "./memory-fs";

/** Samsung's serial format, because it is what shows up in an `mtp://` address
 * and an obviously invented one would read as a placeholder. */
export const PHONE_SERIAL = "R5CW42XKPNZ";
export const PHONE_NAME = "Galaxy Z Fold 7";

export const PEER_ID = "c7f1a9d4";
export const PEER_NAME = "Ada’s MacBook Pro";

/** This tab, as the other device would see it. */
export const SELF_NAME = "Fiddler Web";

/** MTP storage ids are numbers the protocol hands out, not names — 65537 and
 * 131073 are what a Samsung actually reports for internal memory and a card. */
const INTERNAL = 65537;
const CARD = 131073;

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
/** Relative, so a demo shown next year still looks like a phone in use. */
const daysAgo = (days: number, hours = 0) => now() - days * DAY - hours * 3600;

const STORAGES: UsbStorage[] = [
  {
    id: INTERNAL,
    description: "Internal storage",
    freeSpace: 92_300_000_000,
    totalCapacity: 256_000_000_000,
    removable: false,
  },
  {
    id: CARD,
    description: "SD card",
    freeSpace: 61_400_000_000,
    totalCapacity: 128_000_000_000,
    removable: true,
  },
];

/**
 * The phone, at whichever stage the fake connection has reached.
 *
 * `throttled` is true and the link is USB 2.0 because that is the ordinary case
 * rather than the unlucky one — most USB-C cables sold with phones are USB 2.0
 * even though the connector is identical — and it is what puts the link banner
 * on screen, which is one of the things worth demonstrating.
 */
export function phoneAt(stage: "connecting" | "ready"): UsbDevice {
  const base = {
    serial: PHONE_SERIAL,
    name: PHONE_NAME,
    vendorId: 0x04e8, // Samsung
    productId: 0x6860, // the MTP interface every Galaxy exposes
    link: "USB 2.0",
    linkMbps: 480,
    throttled: true,
  };
  // A device that has not finished connecting reports no storages, exactly as a
  // real one does before it has been told to share them.
  return stage === "connecting"
    ? { ...base, stage: "connecting", storages: [] }
    : { ...base, stage: "ready", storages: STORAGES };
}

/**
 * The device root, listed as its storages.
 *
 * Mirrors `storage_entry` in `src-tauri/src/mtp/mod.rs`, which exists because a
 * device root is not a folder — there is nothing on a phone at the level above
 * "Internal storage". Note that the name and the last path segment deliberately
 * disagree: a person reads *Internal storage*, MTP addresses it as 65537. The
 * generic listing in `web.ts` derives a child's path from its name and so can't
 * express that, which is exactly why this is a special case in both backends.
 *
 * Returns null for any path that isn't the phone's root, so the caller can fall
 * through to the ordinary listing.
 */
export function storageListing(path: string, device: UsbDevice): Entry[] | null {
  const root = `mtp://${device.serial}`;
  if (path !== root && path !== `${root}/`) return null;
  return device.storages.map((storage) => ({
    name: storage.description,
    path: `${root}/${storage.id}`,
    kind: "dir" as const,
    linkToDir: false,
    // What's used rather than what's free, matching the Rust side: the size
    // column on a storage row reads as "how much is on it".
    size: Math.max(0, storage.totalCapacity - storage.freeSpace),
    mtime: 0,
    added: 0,
    hidden: false,
    thumbable: false,
    isRepo: false,
    worktreeCount: 0,
    branch: null,
    code: null,
    rollup: null,
  }));
}

export function peer(paired: boolean): PeerDevice {
  return {
    id: PEER_ID,
    name: PEER_NAME,
    host: "192.168.1.24",
    port: 7421,
    paired,
    platform: "macos",
  };
}

// ------------------------------------------------------------- the phone

/** What is on the phone. Keyed by storage id, because that is the first segment
 * of an `mtp://` address and so the first thing `vfs.resolve` hands over. */
export function buildPhone(): MemoryProvider {
  const fs = new MemoryProvider();

  const text = (path: string, body: string, mtime: number) =>
    fs.seedFile(path, new Blob([body], { type: "text/plain" }), mtime);

  /** A photo. SVG rather than JPEG for the same reason the rest of the demo
   * art is: a real photograph is megabytes, and a `.jpg` holding SVG bytes
   * would decode to nothing at all — an empty tile is a worse lie than an
   * honest extension. */
  const photo = (path: string, seed: number, mtime: number) =>
    fs.seedFile(path, new Blob([wallpaper(PALETTES[seed % PALETTES.length], 4801 + seed * 6151)], {
      type: "image/svg+xml",
    }), mtime);

  // Android's camera names files by the second they were taken, and a real
  // camera roll is the strongest thing to land on: a screen of tiles that all
  // have to be read off the device one round trip at a time.
  const shots: [string, number, number][] = [
    ["20260809_174512", 0, 2],
    ["20260809_174534", 1, 2],
    ["20260808_091205", 2, 3],
    ["20260806_203317", 3, 5],
    ["20260803_142058", 4, 8],
    ["20260731_110844", 5, 11],
    ["20260728_195621", 6, 14],
    ["20260722_081339", 7, 20],
  ];
  for (const [name, seed, days] of shots) {
    photo(`${INTERNAL}/DCIM/Camera/${name}.svg`, seed, daysAgo(days, seed));
  }

  photo(`${INTERNAL}/Pictures/Screenshots/Screenshot_20260807_224410.svg`, 11, daysAgo(4));
  photo(`${INTERNAL}/Pictures/Screenshots/Screenshot_20260801_093712.svg`, 13, daysAgo(10));

  text(`${INTERNAL}/Download/boarding pass.txt`, BOARDING_PASS, daysAgo(6));
  text(`${INTERNAL}/Download/read me on the train.md`, TRAIN_NOTES, daysAgo(9));

  text(`${INTERNAL}/Documents/shopping.txt`, SHOPPING, daysAgo(1, 4));

  // The card is where the overflow goes, which is the reason to have two
  // storages at all: the sidebar has a choice to offer and a meter for each.
  photo(`${CARD}/DCIM/Camera/20260614_163055.svg`, 17, daysAgo(58));
  photo(`${CARD}/DCIM/Camera/20260614_163122.svg`, 19, daysAgo(58));
  photo(`${CARD}/DCIM/Camera/20260521_120744.svg`, 23, daysAgo(82));
  text(`${CARD}/Music/playlists/walking.m3u`, PLAYLIST, daysAgo(31));

  return fs;
}

// -------------------------------------------------------------- the peer

/** What the other Fiddler shares. Read-only, which is not a demo shortcut but
 * the real rule: `locationCaps` refuses every write to a `fiddler://` path
 * because the nearby transport has no upload yet. */
export function buildPeer(): MemoryProvider {
  const fs = new MemoryProvider(true);

  const text = (path: string, body: string, mtime: number) =>
    fs.seedFile(path, new Blob([body], { type: "text/plain" }), mtime);

  text("Documents/handover.md", HANDOVER, daysAgo(2));
  text("Documents/expenses.csv", EXPENSES, daysAgo(5));
  text("Desktop/scratch.txt", "ring the venue about the projector\nbook the 7:40\n", daysAgo(0, 5));
  text("Projects/kestrel/README.md", KESTREL, daysAgo(3));
  text("Projects/kestrel/src/main.ts", KESTREL_MAIN, daysAgo(3, 2));

  return fs;
}

// ---------------------------------------------------------------- content

const BOARDING_PASS = `BOARDING PASS
------------------------------------------
Passenger    A. LOVELACE
Flight       BA 1476
From         EDI  Edinburgh
To           LHR  London Heathrow
Gate         12          Seat  14A
Boards       08:05       Zone  3

Scan at the gate. Screenshot it — the signal
in that terminal is famously terrible.
`;

const TRAIN_NOTES = `# Read on the train

Three things I keep meaning to look up.

- Whether the listing cost on a big folder is the round trips or the decode.
  It's the round trips: one per object, and a camera roll is thousands.
- Whether \`GetObjectPropList\` would fix it. It would, and mtp-rs has the
  opcode as a constant and no method behind it.
- Why the phone hands back a video thumbnail so slowly. Because it is decoding
  the video to make one — 85 to 138 ms, measured, versus 7 to 15 for a still.

None of this matters at ten files. All of it matters at two thousand.
`;

const SHOPPING = `oats
tinned tomatoes
coffee (the dark one, not the one from last time)
lemons
washing up liquid
`;

const PLAYLIST = `#EXTM3U
#EXTINF:214,Weather Report
../Music/weather report.mp3
#EXTINF:187,Long Way Round
../Music/long way round.mp3
`;

const HANDOVER = `# Handover

Everything that is mine and shouldn't be by the time I'm back.

## Running

- The nightly rollup. It has never failed; if it does, the answer is almost
  always that the source partition hadn't landed yet. Re-run it, don't debug it.
- The status page. Static, rebuilt hourly, no dependencies worth knowing about.

## Not running, on purpose

- The old importer. It is kept because it is the only thing that can read the
  2019 archives, and it is off because it will happily read them *again* and
  double every row if anyone points it at a live table.

## If something breaks at the weekend

It can wait until Monday. Genuinely — there is nothing in here that a person
depends on inside of a day, and the thing most likely to break is the thing
that would be fixed by waiting.
`;

const EXPENSES = `date,description,category,amount
2026-07-14,Train — Edinburgh to London,travel,84.50
2026-07-14,Coffee at the station,subsistence,3.80
2026-07-15,Hotel — one night,accommodation,142.00
2026-07-15,Dinner,subsistence,26.40
2026-07-16,Train — London to Edinburgh,travel,84.50
2026-07-28,Domain renewal,software,14.00
2026-08-02,Keyboard for the test bench,equipment,129.00
`;

const KESTREL = `# kestrel

A very small static site builder. Reads a folder of markdown, writes a folder
of HTML, and has no configuration file — the folder structure *is* the
configuration.

## Why another one

Every generator I tried wanted me to learn its opinions before it would render
a paragraph. This one has two rules: a folder becomes a directory, and
\`index.md\` becomes that directory's page. That is the whole model.

## Status

Runs this site. Not published, and probably shouldn't be — the world does not
need another one of these, but I did.
`;

const KESTREL_MAIN = `import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { render } from "./render.ts";

/** Walk a folder of markdown and mirror it as HTML. */
export async function build(from: string, to: string): Promise<number> {
  let written = 0;

  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!item.name.endsWith(".md")) continue;

      // index.md becomes the folder's own page; everything else becomes a
      // folder of its own, so no URL ever ends in ".html".
      const stem = item.name === "index.md" ? "" : item.name.slice(0, -3);
      const target = join(to, relative(from, dir), stem, "index.html");

      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, render(await readFile(path, "utf8")));
      written += 1;
    }
  };

  await walk(from);
  return written;
}
`;
