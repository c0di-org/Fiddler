import type { Place } from "../types";
import { FolderIcon, SparkIcon, placeIcon } from "./icons";

interface Props {
  places: Place[];
  current: string;
  onPick: (path: string) => void;
}

export function Sidebar({ places, current, onPick }: Props) {
  return (
    <nav className="sidebar">
      {/* Doubles as the drag region under the traffic lights. */}
      <div className="sidebar-head" data-tauri-drag-region="deep">
        <span className="sidebar-mark">
          <SparkIcon size={15} />
        </span>
        <span className="sidebar-wordmark">Fiddler</span>
      </div>

      <div className="sidebar-title">Favourites</div>
      {places.map((p) => {
        const Icon = placeIcon[p.icon] ?? FolderIcon;
        return (
          <button
            key={p.path}
            className={`place ${p.path === current ? "active" : ""}`}
            onClick={() => onPick(p.path)}
            title={p.path}
          >
            <span className="place-icon">
              <Icon size={18} />
            </span>
            <span className="place-label">{p.name}</span>
          </button>
        );
      })}
    </nav>
  );
}
