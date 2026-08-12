import { transferNote } from "../location";
import type { Volume } from "../types";
import { CableIcon, LockIcon, WifiIcon } from "./icons";

/**
 * A line above the listing that says something about the place you are standing
 * in, rather than about anything you have done.
 *
 * Two of these exist and they are deliberately the same object: the negotiated
 * link speed on a cable, and which way files can travel here at all. Both are
 * facts about the location that are invisible until they cost someone
 * something, and both are worth exactly one sentence and a way to stop being
 * told. Dismissal is the caller's business — what "once" means differs between
 * them, per-cable for one and per-address-space for the other.
 */
export function Banner({
  icon,
  title,
  detail,
  tone = "info",
  action,
  dismissLabel = "Got it",
  onDismiss,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  /** `warn` is for something that is costing you speed; `info` states a rule. */
  tone?: "info" | "warn";
  /** Something to do about it, for the one banner that asks a question rather
   * than stating a fact. Sits before the dismiss so the safe answer is the
   * last thing under the pointer. */
  action?: React.ReactNode;
  /** "Got it" is right for a banner you are only acknowledging; a banner that
   * asked something needs a word that means no. */
  dismissLabel?: string;
  onDismiss: () => void;
}) {
  return (
    <aside className={`notice-banner ${tone}`}>
      {icon}
      <div className="notice-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {action}
      <button className="notice-dismiss" onClick={onDismiss} title="Dismiss">
        {dismissLabel}
      </button>
    </aside>
  );
}

/**
 * Which way files can travel in the address space you are browsing.
 *
 * Renders nothing on a local path, which is the overwhelmingly common case —
 * this must never become a strip that sits above every folder.
 */
export function TransferNoteBanner({
  path,
  volumes = [],
  onDismiss,
}: {
  path: string;
  /** Mounted volumes, so a read-only disk gets the same warning ahead of time
   * that the two device spaces do. Empty is the ordinary case and means "this
   * is somewhere on the startup disk". */
  volumes?: Volume[];
  onDismiss: () => void;
}) {
  const note = transferNote(path, volumes);
  if (!note) return null;
  return (
    <Banner
      icon={
        path.startsWith("mtp://") ? (
          <CableIcon size={15} />
        ) : path.startsWith("fiddler://") ? (
          <WifiIcon size={15} />
        ) : (
          // A read-only disk. The padlock is the same one the sidebar row
          // carries, so the banner and the row read as one fact.
          <LockIcon size={15} />
        )
      }
      title={note.title}
      detail={note.detail}
      onDismiss={onDismiss}
    />
  );
}
