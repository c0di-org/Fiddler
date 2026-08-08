import { EmptyIcon } from "./icons";

/** What both views show when there's nothing to draw. */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="view-empty">
      <EmptyIcon size={44} />
      <span>{message}</span>
    </div>
  );
}
