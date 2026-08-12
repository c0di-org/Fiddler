import { tildify } from "../format";
import { locationCaps, refusal } from "../location";
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
  DeviceIcon,
  LaptopIcon,
} from "./icons";
import { dropProps, useDropTarget, type DropItems } from "./use-drop-target.ts";
import type { PeerDevice, UsbDevice, Volume } from "../types";

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
  device?: PeerDevice;
  /** The cable device the current path belongs to, for the same reason `device`
   * is here: an `mtp://` address is made of a serial and a storage id, and
   * neither is a word anyone would recognise as a place. */
  usbDevice?: UsbDevice | null;
  /** Mounted volumes, so New File knows whether the folder in the crumbs is on
   * a disk that refuses writes. */
  volumes?: Volume[];
  /** A crumb is a folder, so it takes a drop like any other — which is how an
   * item goes back up the tree without navigating away from where it is. */
  onDropItems?: DropItems;
}

export function Toolbar(p: Props) {
  const remote = p.device && p.path.startsWith(`fiddler://${p.device.id}/`);
  const cabled = p.usbDevice && p.path.startsWith(`mtp://${p.usbDevice.serial}/`);
  const crumbs = remote
    ? buildRemoteCrumbs(p.path, p.device!)
    : cabled
      ? buildDeviceCrumbs(p.path, p.usbDevice!)
      : buildCrumbs(p.path, p.home);
  const here = locationCaps(p.path, p.volumes ?? []);

  // "deep" so the gaps between the controls drag the window too; the drag
  // script still refuses to start a drag from buttons, inputs and labels.
  return (
    <header className="toolbar" data-tauri-drag-region="deep">
      <div className="tb-nav">
        <button className="tb-btn" disabled={!p.canBack} onClick={p.onBack} title="Back (⌘[)">
          <ChevronLeft size={18} />
        </button>
        <button
          className="tb-btn tb-forward"
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
            <Crumb
              key={c.path}
              crumb={c}
              here={i === all.length - 1}
              onCrumb={p.onCrumb}
              onDropItems={p.onDropItems}
            >
              {remote && i === 0 && (p.device!.platform === "macos" || p.device!.platform === "desktop" ? <LaptopIcon size={14} /> : <DeviceIcon size={14} />)}
              {c.label}
            </Crumb>
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
        {/* Greyed rather than gone on a device, like Back and Forward: the
            button is a fixture of the toolbar, and moving the view controls
            about as you walk into a phone would be worse than a dead key. */}
        <button
          className="tb-btn tb-new-file"
          disabled={!here.create}
          onClick={p.onNewFile}
          title={here.create ? "New text file (⌘N)" : refusal(here, "create files")}
        >
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
          className={`tb-btn tb-preview ${p.previewOpen ? "on" : ""}`}
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
            title="Search names, paths, and nearby folders; after a pause, Fiddler also checks reasonable text files in this folder. Try ext:ts or kind:dir."
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

function Crumb({
  crumb,
  here,
  onCrumb,
  onDropItems,
  children,
}: {
  crumb: Crumb;
  here: boolean;
  onCrumb: (path: string) => void;
  onDropItems?: DropItems;
  children: React.ReactNode;
}) {
  const drop = useDropTarget(crumb.path, onDropItems);
  const { className: dropClass, ...dropHandlers } = dropProps(drop);
  return (
    <button
      className={`crumb ${here ? "here" : ""} ${dropClass}`}
      onClick={() => onCrumb(crumb.path)}
      {...dropHandlers}
    >
      {children}
    </button>
  );
}

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

function buildRemoteCrumbs(path: string, device: PeerDevice): Crumb[] {
  const rest = path.slice(`fiddler://${device.id}/`.length).split("/").filter(Boolean);
  const out: Crumb[] = [{ label: device.name, path: `fiddler://${device.id}/` }];
  let acc = `fiddler://${device.id}`;
  for (const part of rest) { acc += `/${part}`; out.push({ label: part, path: acc }); }
  return out;
}

/**
 * Crumbs for a device on a cable.
 *
 * Without this an `mtp://` address falls through to `buildCrumbs`, which splits
 * it on "/" like a filesystem path and produces `mtp:` › `R5CW42XKPNZ` › `65537`
 * — three crumbs, none of which names anything a person put there. The serial
 * is the device, and MTP's storage ids are numbers the protocol invented, so
 * both are swapped for what the device calls itself.
 */
function buildDeviceCrumbs(path: string, device: UsbDevice): Crumb[] {
  const rest = path.slice(`mtp://${device.serial}/`.length).split("/").filter(Boolean);
  const out: Crumb[] = [{ label: device.name, path: `mtp://${device.serial}/` }];
  let acc = `mtp://${device.serial}`;
  for (const [depth, part] of rest.entries()) {
    acc += `/${part}`;
    // The first segment is always a storage id. A device with one storage never
    // shows a crumb for it: the person chose the phone, not a partition of it.
    if (depth === 0) {
      if (device.storages.length <= 1) continue;
      const storage = device.storages.find((s) => String(s.id) === part);
      out.push({ label: storage?.description ?? part, path: acc });
      continue;
    }
    out.push({ label: part, path: acc });
  }
  return out;
}
