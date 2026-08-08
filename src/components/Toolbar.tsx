import { tildify } from "../format";
import type { ViewMode } from "../store/tree";
import {
  ChevronLeft,
  Chevron,
  EyeIcon,
  GridIcon,
  ListIcon,
  PanelIcon,
  SearchIcon,
  UpIcon,
} from "./icons";

interface Props {
  path: string;
  home: string;
  view: ViewMode;
  iconSize: number;
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
  onIconSize: (px: number) => void;
  onFilter: (v: string) => void;
  onToggleHidden: () => void;
  onTogglePreview: () => void;
}

export function Toolbar(p: Props) {
  const crumbs = buildCrumbs(p.path, p.home);

  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="tb-nav">
        <button className="tb-btn" disabled={!p.canBack} onClick={p.onBack} title="Back (⌘[)">
          <ChevronLeft size={15} />
        </button>
        <button
          className="tb-btn"
          disabled={!p.canForward}
          onClick={p.onForward}
          title="Forward (⌘])"
        >
          <Chevron size={15} />
        </button>
        <button className="tb-btn" onClick={p.onUp} title="Enclosing folder (⌘↑)">
          <UpIcon size={15} />
        </button>
      </div>

      <nav className="crumbs">
        {crumbs.map((c, i) => (
          <button
            key={c.path}
            className={`crumb ${i === crumbs.length - 1 ? "here" : ""}`}
            onClick={() => p.onCrumb(c.path)}
          >
            {c.label}
          </button>
        ))}
        {p.branch && (
          <span className="crumb-branch" title="Current branch">
            {p.branch}
          </span>
        )}
      </nav>

      <div className="tb-spacer" />

      {p.view === "icons" && (
        <input
          className="tb-size"
          type="range"
          min={48}
          max={192}
          step={8}
          value={p.iconSize}
          onChange={(e) => p.onIconSize(Number(e.target.value))}
          title="Icon size"
        />
      )}

      <div className="tb-seg">
        <button
          className={p.view === "icons" ? "on" : ""}
          onClick={() => p.onView("icons")}
          title="Icons (⌘1)"
        >
          <GridIcon size={14} />
        </button>
        <button
          className={p.view === "list" ? "on" : ""}
          onClick={() => p.onView("list")}
          title="List (⌘2)"
        >
          <ListIcon size={14} />
        </button>
      </div>

      <button
        className={`tb-btn ${p.previewOpen ? "on" : ""}`}
        onClick={p.onTogglePreview}
        title="Preview (⇧⌘P)"
      >
        <PanelIcon size={14} />
      </button>

      <button
        className={`tb-btn ${p.showHidden ? "on" : ""}`}
        onClick={p.onToggleHidden}
        title="Show hidden files (⇧⌘.)"
      >
        <EyeIcon size={14} />
      </button>

      <label className="tb-search">
        <SearchIcon size={13} />
        <input
          value={p.filter}
          placeholder="Search"
          spellCheck={false}
          onChange={(e) => p.onFilter(e.target.value)}
        />
      </label>
    </header>
  );
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
