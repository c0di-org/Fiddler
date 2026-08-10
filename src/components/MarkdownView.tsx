import { useEffect, useMemo, useState } from "react";

import * as ipc from "../ipc";
import { grammarNamed, tokenize, State } from "../preview/highlight";
import { parse, type Block, type Inline, type Item } from "../preview/markdown";

/**
 * Rendered markdown.
 *
 * The parser hands over a tree of plain data, and this walks it into elements —
 * so a README is never converted to an HTML string, and nothing a file contains
 * can become markup. The same rule covers what the document points at: only
 * links with a scheme we trust are clickable, and only images that live on this
 * machine are loaded.
 */

interface Props {
  /** The document's own path, for resolving relative images. */
  path: string;
  source: string;
  /** The narrow presentation used by the preview pane. */
  dense?: boolean;
}

export function MarkdownView({ path, source, dense = false }: Props) {
  const doc = useMemo(() => parse(source), [source]);
  const dir = useMemo(() => path.slice(0, path.lastIndexOf("/") + 1), [path]);

  return (
    <div className={`md${dense ? " dense" : ""}`}>
      {doc.blocks.map((b, i) => (
        <BlockView block={b} dir={dir} key={i} />
      ))}
      {doc.clipped && <p className="md-clipped">Preview stops here — the document continues.</p>}
    </div>
  );
}

function BlockView({ block, dir }: { block: Block; dir: string }) {
  switch (block.t) {
    case "h": {
      const Tag = `h${Math.min(block.level, 6)}` as "h1";
      return (
        <Tag className={`md-h md-h${block.level}`}>
          <Inlines nodes={block.k} dir={dir} />
        </Tag>
      );
    }
    case "p":
      return (
        <p className="md-p">
          <Inlines nodes={block.k} dir={dir} />
        </p>
      );
    case "pre":
      return <Fence lang={block.lang} code={block.v} />;
    case "hr":
      return <hr className="md-hr" />;
    case "quote":
      return (
        <blockquote className="md-quote">
          {block.blocks.map((b, i) => (
            <BlockView block={b} dir={dir} key={i} />
          ))}
        </blockquote>
      );
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className="md-list" start={block.ordered ? block.start : undefined}>
          {block.items.map((it, i) => (
            <ItemView item={it} dir={dir} key={i} />
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        // Wide tables scroll inside themselves rather than stretching the column
        // of prose they interrupt.
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th style={{ textAlign: block.align[i] ?? "left" }} key={i}>
                    <Inlines nodes={cell} dir={dir} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td style={{ textAlign: block.align[i] ?? "left" }} key={i}>
                      <Inlines nodes={cell} dir={dir} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function ItemView({ item, dir }: { item: Item; dir: string }) {
  return (
    <li className={item.task ? "md-task" : undefined}>
      {item.task && <span className={`md-check${item.done ? " done" : ""}`} aria-hidden />}
      {item.blocks.map((b, i) => (
        <BlockView block={b} dir={dir} key={i} />
      ))}
    </li>
  );
}

/** Fenced code, highlighted with whatever grammar the info string named. */
function Fence({ lang, code }: { lang: string; code: string }) {
  const grammar = useMemo(() => grammarNamed(lang), [lang]);
  const lines = useMemo(() => code.split("\n"), [code]);

  return (
    <pre className="md-pre">
      <code>
        {lines.map((line, i) => {
          const tokens = tokenize(line, State.Normal, grammar);
          return (
            <span className="md-pre-line" key={i}>
              {tokens.map((t, j) =>
                t.k === "txt" ? t.v : (
                  <span className={`t-${t.k}`} key={j}>
                    {t.v}
                  </span>
                )
              )}
              {"\n"}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function Inlines({ nodes, dir }: { nodes: Inline[]; dir: string }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return n.v;
          case "code":
            return (
              <code className="md-code" key={i}>
                {n.v}
              </code>
            );
          case "strong":
            return (
              <strong key={i}>
                <Inlines nodes={n.k} dir={dir} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines nodes={n.k} dir={dir} />
              </em>
            );
          case "del":
            return (
              <del key={i}>
                <Inlines nodes={n.k} dir={dir} />
              </del>
            );
          case "link":
            return (
              <Link href={n.href} key={i}>
                <Inlines nodes={n.k} dir={dir} />
              </Link>
            );
          case "img":
            return <Image src={n.src} alt={n.alt} dir={dir} key={i} />;
        }
      })}
    </>
  );
}

/** Only `http`, `https` and `mailto` are handed to the OS; the rest are inert. */
function Link({ href, children }: { href: string; children: React.ReactNode }) {
  const safe = /^(https?|mailto):/i.test(href);
  if (!safe) {
    return (
      <span className="md-link dead" title={href}>
        {children}
      </span>
    );
  }
  return (
    <span
      className="md-link"
      title={href}
      role="link"
      tabIndex={0}
      onClick={() => void ipc.openExternal(href)}
      onKeyDown={(e) => e.key === "Enter" && void ipc.openExternal(href)}
    >
      {children}
    </span>
  );
}

/**
 * An image that lives next to the document is shown by rendering it — the same
 * cached thumbnail path every other preview takes — rather than by pointing the
 * webview at the file. Two things fall out of that, both wanted: the only paths
 * the renderer ever loads are inside our own cache, and a document that points
 * at something which isn't an image gets alt text instead of a read.
 *
 * A remote image is never fetched. A preview is not a reason to make a network
 * request on someone's behalf.
 */
function Image({ src, alt, dir }: { src: string; alt: string; dir: string }) {
  const remote = /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
  const full = useMemo(() => (remote ? "" : resolve(dir, src)), [remote, dir, src]);
  const [rendered, setRendered] = useState<string | null>(null);
  const [missing, setMissing] = useState(remote);

  useEffect(() => {
    if (remote) return;
    let alive = true;
    setRendered(null);
    setMissing(false);
    ipc
      .thumbnail(full, 1200)
      .then((p) => {
        if (!alive) return;
        if (p) setRendered(p);
        else setMissing(true);
      })
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [full, remote]);

  if (missing) return <span className="md-img-remote">{alt || "image"}</span>;
  if (!rendered) return <span className="md-img-holding" aria-hidden />;
  return <img className="md-img" src={ipc.fileSrc(rendered)} alt={alt} draggable={false} />;
}

/** Join a relative image reference onto the document's folder. */
function resolve(dir: string, src: string): string {
  // Strip a fragment or query, and undo the percent-encoding a markdown author
  // uses for spaces in a filename.
  const clean = src.split(/[?#]/)[0];
  let path: string;
  try {
    path = decodeURIComponent(clean);
  } catch {
    path = clean;
  }
  return path.startsWith("/") ? path : dir + path;
}
