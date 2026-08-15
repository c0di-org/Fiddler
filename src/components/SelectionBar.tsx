import { CloseIcon, CopyIcon, MoreIcon, ShareIcon, TrashIcon } from "./icons";

/**
 * What the status bar becomes under a finger, once there is a selection.
 *
 * Android puts this at the top of the screen; Fiddler's has always been at the
 * bottom, because that is where the count already lived on all three platforms
 * — and on a phone held in one hand it is also the only end of the screen a
 * thumb can reach. So nothing new appears: the bar that has always said "3 of
 * 40 selected" simply grows the verbs that go with it.
 *
 * Four of them, and no more. The bar is a shortcut, not the menu — everything
 * else is behind the overflow, which opens the same list a right-click opens on
 * a desktop. Choosing which four is the whole design: these are the verbs a
 * hand reaches for on a phone, where Reveal in Finder and Open in Terminal are
 * not even offered by the platform.
 */
interface Props {
  count: number;
  /** Absent where nothing in the selection could go to a share sheet. */
  onShare?: () => void;
  /** Absent where the address underneath refuses reads or writes. */
  onCopy?: () => void;
  onTrash?: () => void;
  /** Says "Delete" rather than "Trash" where deletion is permanent, which is
   * the same distinction the menu and the confirmation both make. */
  trashIsPermanent: boolean;
  onMore: () => void;
  onClear: () => void;
}

export function SelectionBar({ count, onShare, onCopy, onTrash, trashIsPermanent, onMore, onClear }: Props) {
  return (
    <div className="selbar" role="toolbar" aria-label={`${count} selected`}>
      <button className="selbar-btn" onClick={onClear} title="Clear selection" aria-label="Clear selection">
        <CloseIcon size={16} />
      </button>
      <span className="selbar-count">
        {count} selected
      </span>
      <div className="selbar-actions">
        {onShare && (
          <button className="selbar-btn" onClick={onShare} title="Share…" aria-label="Share">
            <ShareIcon size={17} />
          </button>
        )}
        {onCopy && (
          <button className="selbar-btn" onClick={onCopy} title="Copy" aria-label="Copy">
            <CopyIcon size={17} />
          </button>
        )}
        {onTrash && (
          <button
            className="selbar-btn danger"
            onClick={onTrash}
            title={trashIsPermanent ? "Delete…" : "Move to Trash"}
            aria-label={trashIsPermanent ? "Delete" : "Move to Trash"}
          >
            <TrashIcon size={17} />
          </button>
        )}
        <button className="selbar-btn" onClick={onMore} title="More…" aria-label="More actions">
          <MoreIcon size={17} />
        </button>
      </div>
    </div>
  );
}
