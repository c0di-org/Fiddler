import { useEffect, useRef } from "react";

import type { DeviceAccess, NearbyAccess } from "../types";
import { CloseIcon, DeviceIcon, LaptopIcon, LockIcon } from "./icons";

/**
 * Everything nearby pairing has granted, and the way to take it back.
 *
 * Allow was a tap, and until this existed that tap was the last time anyone
 * could see or change what it did — the token went into `peers.json` and stayed
 * there. So the point of this panel is not the list, it's the two buttons.
 *
 * The two directions are kept visibly apart because they are different
 * questions with unrelated answers. Withdrawing tells a device it can no longer
 * read *your* files; forgetting only drops *your* key to *its* files, and
 * changes nothing on the machine at the other end. A single merged list would
 * quietly invite the belief that one button did both.
 *
 * Offline devices are listed rather than hidden. A device that isn't on the
 * network still holds its token, and the case this panel exists for is the
 * laptop you lent someone in March.
 */
export function NearbyAccessSheet({
  access,
  busy,
  onWithdraw,
  onForget,
  onClose,
}: {
  access: NearbyAccess;
  /** The device id currently being revoked, so its row can say so. */
  busy: string | null;
  onWithdraw: (device: DeviceAccess) => void;
  onForget: (device: DeviceAccess) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  // Unlike PairAsk, this one was asked for, so it takes focus: Escape should
  // close it without first having to click it.
  useEffect(() => panel.current?.focus(), []);

  const nothing = access.allowed.length === 0 && access.trusted.length === 0;

  return (
    <div className="sheet-veil" onClick={onClose}>
      <div
        className="sheet"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <header className="sheet-head">
          <div>
            <strong id="access-title">Nearby access</strong>
            {access.selfName && <span className="sheet-sub">This device is {access.selfName}</span>}
          </div>
          <button className="sheet-close" aria-label="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </header>

        {nothing ? (
          <p className="sheet-empty">
            No device has been allowed to browse this one, and this one holds no keys to any other.
          </p>
        ) : (
          <div className="sheet-body">
            <AccessList
              title="Can browse this device"
              detail="These can read and copy files in your home folder, whenever they are on the same network."
              devices={access.allowed}
              action="Withdraw"
              empty="Nothing has been allowed."
              busy={busy}
              onPick={onWithdraw}
              showSince
            />
            <AccessList
              title="This device can browse"
              detail="Keys kept from being allowed elsewhere. Forgetting one changes nothing on that device — you will simply have to ask again."
              devices={access.trusted}
              action="Forget"
              empty="No device has allowed this one."
              busy={busy}
              onPick={onForget}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function AccessList({
  title,
  detail,
  devices,
  action,
  empty,
  busy,
  onPick,
  showSince = false,
}: {
  title: string;
  detail: string;
  devices: DeviceAccess[];
  action: string;
  empty: string;
  busy: string | null;
  onPick: (device: DeviceAccess) => void;
  showSince?: boolean;
}) {
  return (
    <section className="access-group">
      <h3 className="access-title">
        <LockIcon size={12} />
        {title}
      </h3>
      <p className="access-detail">{detail}</p>
      {devices.length === 0 ? (
        <p className="access-empty">{empty}</p>
      ) : (
        <ul className="access-list">
          {devices.map((device) => (
            <li key={device.id} className={`access-row ${device.online ? "" : "away"}`}>
              <span className="access-icon">
                {device.platform === "android" ? <DeviceIcon size={17} /> : <LaptopIcon size={17} />}
              </span>
              <span className="access-name">
                {device.name}
                <span className="access-when">
                  {device.online ? "On the network now" : "Not on the network"}
                  {showSince && device.since > 0 && ` · allowed ${allowedOn(device.since)}`}
                </span>
              </span>
              <button
                className="access-revoke"
                disabled={busy === device.id}
                onClick={() => onPick(device)}
              >
                {busy === device.id ? "…" : action}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A date rather than "3 months ago": the question being answered is "was that
 * the time I lent them the laptop", which wants the day, not the interval. */
function allowedOn(since: number): string {
  return new Date(since * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
