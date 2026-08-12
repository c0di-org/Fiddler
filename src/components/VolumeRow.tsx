import type { EjectOutcome, Volume, VolumeKind } from "../types";
// The same two functions that measure a phone's storage. A drive and an SD card
// in a phone are the same question and deserve the same answer, down to the
// rounding.
import { capacity, fullness } from "../usb";
import { ejectNotice, volumeNotice } from "../volumes";
import { Banner } from "./Banner";
import {
  DeviceIcon,
  DiskImageIcon,
  DriveIcon,
  EjectIcon,
  LockIcon,
  NetworkDriveIcon,
} from "./icons";

/** What each kind of volume looks like.
 *
 * Four glyphs for five kinds: `startup` never reaches here, and the remaining
 * distinctions are the ones that change what you would *do* — a share can drop
 * out from under you, a disk image is really a file, a card comes out. */
const glyph: Record<VolumeKind, (p: { size?: number; className?: string }) => React.ReactElement> = {
  startup: DeviceIcon,
  internal: DeviceIcon,
  removable: DriveIcon,
  diskImage: DiskImageIcon,
  network: NetworkDriveIcon,
};

/**
 * One mounted volume in the sidebar: where it is, how full, and a way to put it
 * away.
 *
 * Deliberately the same shape as `UsbStorageRow` — icon, name, meter, free
 * space — because a partition on a drive and a storage in a phone are the same
 * thing seen from two sides, and someone who has learned to read one row should
 * not have to learn the other.
 */
export function VolumeRow({
  volume,
  active,
  busy,
  onPick,
  onEject,
}: {
  volume: Volume;
  active: boolean;
  /** An eject is in flight for this volume. */
  busy?: boolean;
  onPick: (path: string) => void;
  /** Absent where nothing can be ejected — the Android build, which has
   * removable storage and no safe way for an app to unmount it. */
  onEject?: (volume: Volume) => void;
}) {
  const notice = volumeNotice(volume);
  const used = fullness(volume);
  // A share that hasn't said how big it is gets no meter rather than an empty
  // one, which would read as "completely full of nothing".
  const measured = volume.totalCapacity > 0;
  const ejectable = volume.ejectable && !!onEject;

  return (
    <div className="volume">
      <button
        className={`place volume-row ${active ? "active" : ""}`}
        onClick={() => onPick(volume.path)}
        title={measured ? `${volume.path} — ${capacity(volume.freeSpace)} free of ${capacity(volume.totalCapacity)}` : volume.path}
      >
        <span className="place-icon">
          {(glyph[volume.kind] ?? DriveIcon)({ size: 17 })}
        </span>
        <span className="volume-body">
          <span className="volume-name">
            <span className="place-label">{volume.name}</span>
            {/* Says why Save is going to be missing, before it is missed. */}
            {volume.readOnly && <LockIcon size={11} className="volume-locked" />}
          </span>
          {measured && (
            <>
              <span className="usb-meter">
                <span className="usb-meter-fill" style={{ width: `${Math.round(used * 100)}%` }} />
              </span>
              <span className="usb-storage-free">{capacity(volume.freeSpace)} free</span>
            </>
          )}
        </span>
      </button>
      {ejectable && (
        <button
          className="volume-eject"
          aria-label={`Eject ${volume.name}`}
          title={volume.kind === "network" ? `Disconnect ${volume.name}` : `Eject ${volume.name}`}
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onEject?.(volume);
          }}
        >
          <EjectIcon size={13} />
        </button>
      )}
      {/* Under the name rather than replacing the row, exactly as a phone's
          stage is: a disk that can't be read yet is still a disk that is
          plainly plugged in, and making it vanish would be the lie. */}
      {notice && (
        <div className={`usb-stage ${notice.resolves ? "waiting" : "stopped"}`}>
          {notice.resolves && <span className="usb-pulse" />}
          {notice.title}
        </div>
      )}
    </div>
  );
}

/**
 * The question asked when a volume refuses to be ejected.
 *
 * A banner rather than a `window.confirm`, for three reasons. Nothing is
 * waiting on the answer — the disk is still mounted and still safe, so there is
 * nothing to be modal about. The two answers can be named, and "Eject anyway"
 * against "Leave it mounted" says far more than OK and Cancel. And a dialog
 * whose default is dismissed by pressing Return is the wrong shape for the one
 * question in this app that can cost somebody a write.
 *
 * "Eject anyway" is spelled out rather than labelled "Force", and the detail
 * says what it costs.
 */
export function EjectBusyBanner({
  volume,
  outcome,
  onForce,
  onDismiss,
}: {
  volume: Volume;
  outcome: EjectOutcome;
  onForce: () => void;
  onDismiss: () => void;
}) {
  const notice = ejectNotice(volume, outcome);
  if (!notice) return null;
  return (
    <Banner
      icon={<EjectIcon size={15} />}
      title={notice.title}
      detail={notice.detail}
      tone="warn"
      dismissLabel="Leave it mounted"
      action={
        <button className="notice-action" onClick={onForce}>
          Eject anyway
        </button>
      }
      onDismiss={onDismiss}
    />
  );
}

/** What fills the content area when you open a volume that can't be read.
 *
 * The sibling of `UsbConnecting`, and for the same reason: an empty grid is
 * indistinguishable from an empty disk, and the difference is the whole
 * message. */
export function VolumeBlocked({ volume }: { volume: Volume }) {
  const notice = volumeNotice(volume);
  if (!notice) return null;
  return (
    <div className="usb-panel">
      <div className={`usb-panel-glyph ${notice.resolves ? "waiting" : "stopped"}`}>
        {(glyph[volume.kind] ?? DriveIcon)({ size: 38 })}
      </div>
      <h2>{notice.title}</h2>
      <p>{notice.detail}</p>
      {notice.resolves && (
        <div className="usb-panel-live">
          <span className="usb-pulse" />
          Watching for it — nothing to click here
        </div>
      )}
    </div>
  );
}
