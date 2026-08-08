import type { Place } from "../types";
import { FolderIcon, placeIcon } from "./icons";

interface Props {
  places: Place[];
  current: string;
  onPick: (path: string) => void;
}

export function Sidebar({ places, current, onPick }: Props) {
  return (
    <nav className="sidebar">
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
            <Icon size={15} />
            <span>{p.name}</span>
          </button>
        );
      })}
    </nav>
  );
}
