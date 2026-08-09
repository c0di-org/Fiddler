import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { grammarFor, scan, tokenize, type State } from "../preview/highlight";

/**
 * A file of source, virtualized by line.
 *
 * Same shape as the folder views: a sizer holding the full height, a window
 * translated into place, and only the visible rows in the DOM. Highlighting
 * hangs off the same window — each line is tokenized as it scrolls in and thrown
 * away as it leaves, so opening a 200,000-line lockfile costs one scan for the
 * comment states and sixty tokenized lines, not two million spans.
 */

/** Line box heights, which have to match the CSS exactly for scrolling to line up. */
const LINE_H = { normal: 20, dense: 15 };
const OVERSCAN = 24;

interface Props {
  /** The file's name or path — only used to pick a grammar. */
  name: string;
  text: string;
  /** Wrap long lines instead of scrolling sideways. Prose wants this; code doesn't. */
  wrap?: boolean;
  /** The narrow presentation used by the preview pane. */
  dense?: boolean;
  /** Line numbers in a gutter. Off in the pane, where there's no room. */
  gutter?: boolean;
}

export function CodeView({ name, text, wrap = false, dense = false, gutter = false }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  const lines = useMemo(() => text.split("\n"), [text]);
  const grammar = useMemo(() => (wrap ? null : grammarFor(name)), [name, wrap]);
  // The one pass over the whole file: a byte a line, and only when a grammar
  // has block comments to track.
  const states = useMemo(() => scan(lines, grammar), [lines, grammar]);

  const rowH = dense ? LINE_H.dense : LINE_H.normal;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // A new file starts at the top, not wherever the last one was left.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
  }, [name, text]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  // Wrapped text has no fixed row height to count in, so it renders whole. The
  // callers that ask for wrapping are the ones showing a bounded head of a file.
  if (wrap) {
    return (
      <div className={box(dense, true)} ref={scroller}>
        <pre className="code-wrapped">{text}</pre>
      </div>
    );
  }

  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((scrollTop + viewport) / rowH) + OVERSCAN);
  const width = String(lines.length).length;

  return (
    <div className={box(dense, false)} ref={scroller} onScroll={onScroll}>
      <div className="code-sizer" style={{ height: lines.length * rowH }}>
        <div className="code-window" style={{ transform: `translateY(${first * rowH}px)` }}>
          {lines.slice(first, last).map((line, n) => (
            <div className="code-line" key={first + n} style={{ height: rowH }}>
              {gutter && (
                <span className="code-no" style={{ width: `${width}ch` }}>
                  {first + n + 1}
                </span>
              )}
              <span className="code-text">
                <Spans line={line} state={states[first + n] as State} grammar={grammar} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const box = (dense: boolean, wrap: boolean) =>
  `code-scroller${dense ? " dense" : ""}${wrap ? " wrapped" : ""}`;

function Spans({
  line,
  state,
  grammar,
}: {
  line: string;
  state: State;
  grammar: ReturnType<typeof grammarFor>;
}) {
  // A blank line still needs to occupy its row.
  if (!line) return <>{" "}</>;
  const tokens = tokenize(line, state, grammar);
  return (
    <>
      {tokens.map((t, i) =>
        t.k === "txt" ? t.v : (
          <span className={`t-${t.k}`} key={i}>
            {t.v}
          </span>
        )
      )}
    </>
  );
}
