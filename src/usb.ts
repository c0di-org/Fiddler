import type { UsbDevice } from "./types";

/**
 * What to say about a device that isn't browsable yet.
 *
 * Every one of these replaces some variant of "device not detected", which is
 * what other MTP apps show for all of them. Each stage here is a real, distinct
 * thing that happened, and each has something the person can actually do.
 */
export interface Notice {
  title: string;
  detail: string;
  /** Whether Fiddler will clear this by itself once the person acts. */
  resolves: boolean;
}

export function connectionNotice(device: UsbDevice): Notice | null {
  switch (device.stage) {
    case "ready":
      return null;
    case "connecting":
      return {
        title: `Connecting to ${device.name}…`,
        detail: "Opening the cable connection.",
        resolves: true,
      };
    case "awaitingGrant":
      return {
        // The phone is open and has told us its model. It just isn't sharing.
        title: `Unlock ${device.name} to continue`,
        detail:
          "Then pull down the notification shade, tap the USB notification, and choose “File transfer”. Fiddler will pick it up on its own.",
        resolves: true,
      };
    case "blocked":
      return {
        title: device.owner
          ? `${device.owner} is holding ${device.name}`
          : `Another app is holding ${device.name}`,
        detail: device.owner?.includes("ptpcamerad")
          ? "macOS's camera daemon claims phones on connection but can't transfer files from them. Quitting it hands the device back."
          : "Only one app can talk to a device at a time. Quit the other one and Fiddler will connect automatically.",
        resolves: true,
      };
    case "failed":
      return { title: `Couldn't reach ${device.name}`, detail: device.message, resolves: false };
  }
}

/**
 * What to say about a slow link, or null when there's nothing worth saying.
 *
 * The wording matters more than it looks. USB reports the speed both ends
 * negotiated and nothing else — it cannot tell us whether the phone, the cable,
 * or the port set the ceiling. So this states the measured fact, gives the
 * practical cost, and offers the most likely cause as a possibility. It never
 * says "your cable is bad", because we don't know that.
 */
export function linkNotice(device: UsbDevice): Notice | null {
  if (!device.throttled || !device.link) return null;
  return {
    title: `Connected over ${device.link}`,
    detail: `${device.link} caps large transfers at roughly 40 MB/s. If ${device.name} supports USB 3, a different cable or port would be about twice as fast — most USB-C cables sold with phones are USB 2.0 even though the connector looks identical.`,
    resolves: false,
  };
}

/** Bytes as a short human string, for storage meters. */
export function capacity(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/** How full a storage is, 0–1, for the meter under a device row. */
export function fullness(storage: { freeSpace: number; totalCapacity: number }): number {
  if (storage.totalCapacity <= 0) return 0;
  const used = storage.totalCapacity - storage.freeSpace;
  return Math.min(1, Math.max(0, used / storage.totalCapacity));
}
