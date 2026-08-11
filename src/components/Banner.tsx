import { transferNote } from "../location";
import { CableIcon, WifiIcon } from "./icons";

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
  onDismiss,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  /** `warn` is for something that is costing you speed; `info` states a rule. */
  tone?: "info" | "warn";
  onDismiss: () => void;
}) {
  return (
    <aside className={`notice-banner ${tone}`}>
      {icon}
      <div className="notice-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <button className="notice-dismiss" onClick={onDismiss} title="Dismiss">
        Got it
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
export function TransferNoteBanner({ path, onDismiss }: { path: string; onDismiss: () => void }) {
  const note = transferNote(path);
  if (!note) return null;
  return (
    <Banner
      icon={path.startsWith("mtp://") ? <CableIcon size={15} /> : <WifiIcon size={15} />}
      title={note.title}
      detail={note.detail}
      onDismiss={onDismiss}
    />
  );
}
