import { useLayoutEffect, useRef } from "react";

/**
 * The inline rename field, shared by both views: name selected up to the
 * extension, Enter commits, Escape walks away, and losing focus commits —
 * because on a tablet the thing most likely to take focus is the keyboard
 * being dismissed, and losing the typed name with it would be worse than
 * keeping it.
 *
 * `settled` is load-bearing: answering Enter or Escape makes the host move
 * focus back to the view *while this input is still mounted*, so the blur
 * that follows must not speak again — without the flag, Enter renamed twice
 * (the second racing the first into ENOENT) and Escape committed the very
 * rename it was walking away from.
 */
export function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  return (
    <input
      ref={ref}
      className="rename-input"
      aria-label={`Rename ${initial}`}
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (settled.current) return;
        settled.current = true;
        onCommit(e.currentTarget.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (settled.current) return;
        if (e.key === "Enter") {
          settled.current = true;
          onCommit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          settled.current = true;
          onCancel();
        }
      }}
    />
  );
}
