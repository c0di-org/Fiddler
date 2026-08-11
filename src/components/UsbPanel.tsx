import type { UsbDevice } from "../types";
import { capacity, connectionNotice, fullness, linkNotice } from "../usb";
import { Banner } from "./Banner";
import { BoltIcon, DeviceIcon, SdCardIcon } from "./icons";

/**
 * What fills the content area when you open a device that isn't browsable yet.
 *
 * Deliberately not a modal and not an error page. The stages it shows are steps
 * in a sequence that is still moving, and every one of them clears on its own
 * when the person does the thing — so this is a place to wait that tells you
 * what you're waiting for.
 */
export function UsbConnecting({
  device,
  onRelease,
}: {
  device: UsbDevice;
  onRelease?: (device: UsbDevice) => void;
}) {
  const notice = connectionNotice(device);
  if (!notice) return null;
  // Only offer the button when there is a named process we are willing to end.
  // Without a name there is nothing to promise, and the panel says so instead.
  const releasable = device.stage === "blocked" && !!device.owner && !!onRelease;
  return (
    <div className="usb-panel">
      <div className={`usb-panel-glyph ${notice.resolves ? "waiting" : "stopped"}`}>
        <DeviceIcon size={38} />
      </div>
      <h2>{notice.title}</h2>
      <p>{notice.detail}</p>
      {releasable && (
        <button className="usb-panel-fix" onClick={() => onRelease?.(device)}>
          Quit {device.stage === "blocked" ? device.owner : ""} and connect
        </button>
      )}
      {notice.resolves && (
        <div className="usb-panel-live">
          <span className="usb-pulse" />
          {releasable ? "Reconnects on its own once it lets go" : "Watching for it — nothing to click"}
        </div>
      )}
    </div>
  );
}

/**
 * The link banner, shown once above a device's own listing.
 *
 * It appears only when the negotiated link is USB 2.0 or slower, and it is
 * phrased as an observation rather than a diagnosis: see `linkNotice`.
 */
export function UsbLinkBanner({
  device,
  onDismiss,
}: {
  device: UsbDevice;
  onDismiss: () => void;
}) {
  const notice = linkNotice(device);
  if (!notice) return null;
  return (
    <Banner
      icon={<BoltIcon size={15} />}
      title={notice.title}
      detail={notice.detail}
      tone="warn"
      onDismiss={onDismiss}
    />
  );
}

/** A storage row under a device in the sidebar, with how full it is. */
export function UsbStorageRow({
  device,
  storage,
  active,
  onPick,
}: {
  device: UsbDevice;
  storage: UsbDevice["storages"][number];
  active: boolean;
  onPick: (path: string) => void;
}) {
  const used = fullness(storage);
  return (
    <button
      className={`place usb-storage ${active ? "active" : ""}`}
      onClick={() => onPick(`mtp://${device.serial}/${storage.id}`)}
      title={`${capacity(storage.freeSpace)} free of ${capacity(storage.totalCapacity)}`}
    >
      <span className="place-icon">
        {storage.removable ? <SdCardIcon size={17} /> : <DeviceIcon size={17} />}
      </span>
      <span className="usb-storage-body">
        <span className="place-label">{storage.description}</span>
        <span className="usb-meter">
          <span className="usb-meter-fill" style={{ width: `${Math.round(used * 100)}%` }} />
        </span>
        <span className="usb-storage-free">{capacity(storage.freeSpace)} free</span>
      </span>
    </button>
  );
}
