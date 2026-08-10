import { tildify } from "../format";
import type { ViewMode } from "../store/tree";
import {
  BranchIcon,
  ChevronLeft,
  Chevron,
  EyeIcon,
  GridIcon,
  ListIcon,
  PanelIcon,
  NewFileIcon,
  SearchIcon,
  UpIcon,
} from "./icons";

interface Props {
  path: string;
  home: string;
  view: ViewMode;
  filter: string;
  showHidden: boolean;
  previewOpen: boolean;
  canBack: boolean;
  canForward: boolean;
  /** Branch of the repo the current folder belongs to, if any. */
  branch: string | null;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onCrumb: (path: string) => void;
  onView: (v: ViewMode) => void;
  onFilter: (v: string) => void;
  onToggleHidden: () => void;
  onTogglePreview: () => void;
  onNewFile: () => void;
}

export function Toolbar(p: Props) {
  const crumbs = buildCrumbs(p.path, p.home);

  // "deep" so the gaps between the controls drag the window too; the drag
  // script still refuses to start a drag from buttons, inputs and labels.
  return (
    <header className="toolbar" data-tauri-drag-region="deep">
      <div className="tb-nav">
        <button className="tb-btn" disabled={!p.canBack} onClick={p.onBack} title="Back (⌘[)">
          <ChevronLeft size={18} />
        </button>
        <button
          className="tb-btn"
          disabled={!p.canForward}
          onClick={p.onForward}
          title="Forward (⌘])"
        >
          <Chevron size={18} />
        </button>
        <button className="tb-btn" onClick={p.onUp} title="Enclosing folder (⌘↑)">
          <UpIcon size={18} />
        </button>
      </div>

      <nav className="crumbs">
        {collapse(crumbs).map((c, i, all) =>
          c === ELLIPSIS ? (
            <span key="gap" className="crumb crumb-gap" title={p.path}>
              …
            </span>
          ) : (
            <button
              key={c.path}
              className={`crumb ${i === all.length - 1 ? "here" : ""}`}
              onClick={() => p.onCrumb(c.path)}
            >
              {c.label}
            </button>
          )
        )}
      </nav>

      {/* Outside .crumbs, which clips: a long path must never eat the branch. */}
      {p.branch && (
        <span className="crumb-branch" title="Current branch">
          <BranchIcon size={12} />
          <span className="crumb-branch-name">{p.branch}</span>
        </span>
      )}

      <div className="tb-spacer" />

      <div className="tb-tools">
        <button className="tb-btn tb-new-file" onClick={p.onNewFile} title="New text file (⌘N)">
          <NewFileIcon size={17} />
        </button>
        <div className="tb-seg" data-at={p.view === "icons" ? 0 : 1}>
          <button
            className={p.view === "icons" ? "on" : ""}
            onClick={() => p.onView("icons")}
            title="Icons (⌘1)"
          >
            <GridIcon size={16} />
          </button>
          <button
            className={p.view === "list" ? "on" : ""}
            onClick={() => p.onView("list")}
            title="List (⌘2)"
          >
            <ListIcon size={16} />
          </button>
        </div>

        <button
          className={`tb-btn ${p.previewOpen ? "on" : ""}`}
          onClick={p.onTogglePreview}
          title="Preview (⇧⌘P)"
        >
          <PanelIcon size={17} />
        </button>

        <button
          className={`tb-btn ${p.showHidden ? "on" : ""}`}
          onClick={p.onToggleHidden}
          title="Show hidden files (⇧⌘.)"
        >
          <EyeIcon size={17} />
        </button>

        <label className="tb-search">
          <SearchIcon size={15} />
          <input
            value={p.filter}
            placeholder="Search files"
            title="Search names and paths. If there are no local matches, Fiddler looks two folders deep. Try ext:ts or kind:dir."
            spellCheck={false}
            onChange={(e) => p.onFilter(e.target.value)}
          />
        </label>
      </div>
    </header>
  );
}

type Crumb = { label: string; path: string };

const ELLIPSIS = { label: "…", path: "" };

/**
 * Deep paths get their middle elided rather than letting every segment shrink to
 * two illegible characters. The root and the last two are what people navigate
 * with; everything between them is one "…".
 */
function collapse(crumbs: Crumb[]): Crumb[] {
  if (crumbs.length <= 3) return crumbs;
  return [crumbs[0], ELLIPSIS, ...crumbs.slice(-2)];
}

function buildCrumbs(path: string, home: string) {
  if (!path) return [];
  const shown = tildify(path, home);
  const parts = shown.split("/").filter(Boolean);
  const prefix = shown.startsWith("~") ? home.slice(0, home.lastIndexOf("/")) : "";

  const out: { label: string; path: string }[] = [];
  let acc = prefix;
  for (const part of parts) {
    acc = part === "~" ? home : `${acc}/${part}`;
    out.push({ label: part === "~" ? "Home" : part, path: acc });
  }
  return out;
}
