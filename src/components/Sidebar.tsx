import { useState } from "react";

import { FAVORITE_DRAG_TYPE, FOLDER_DRAG_TYPE } from "../favorites";
import type { Favorite, Place } from "../types";
import { CloseIcon, FolderIcon, HeartIcon, SparkIcon, placeIcon } from "./icons";

interface Props {
  places: Place[];
  favorites: Favorite[];
  current: string;
  onPick: (path: string) => void;
  onAddFavorite: (favorite: Favorite, at?: number) => void;
  onRemoveFavorite: (path: string) => void;
  onMoveFavorite: (path: string, at: number) => void;
}

type DragKind = "folder" | "favorite";

function dragKind(event: React.DragEvent): DragKind | null {
  const types = event.dataTransfer.types;
  if (Array.from(types).includes(FAVORITE_DRAG_TYPE)) return "favorite";
  if (Array.from(types).includes(FOLDER_DRAG_TYPE)) return "folder";
  return null;
}

function favoriteFrom(event: React.DragEvent, type: string): Favorite | null {
  try {
    const value: unknown = JSON.parse(event.dataTransfer.getData(type));
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as Favorite).name !== "string" ||
      typeof (value as Favorite).path !== "string"
    ) {
      return null;
    }
    return value as Favorite;
  } catch {
    return null;
  }
}

export function Sidebar({
  places,
  favorites,
  current,
  onPick,
  onAddFavorite,
  onRemoveFavorite,
  onMoveFavorite,
}: Props) {
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingFavorite, setDraggingFavorite] = useState(false);

  const clearDrop = () => setDropIndex(null);

  const allowFavoriteDrop = (event: React.DragEvent, at: number) => {
    const kind = dragKind(event);
    if (!kind) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = kind === "favorite" ? "move" : "copy";
    setDropIndex(at);
    return true;
  };

  const dropFavorite = (event: React.DragEvent, at: number) => {
    const kind = dragKind(event);
    if (!kind) return;
    event.preventDefault();
    clearDrop();
    const favorite = favoriteFrom(event, kind === "favorite" ? FAVORITE_DRAG_TYPE : FOLDER_DRAG_TYPE);
    if (!favorite) return;
    if (kind === "favorite") onMoveFavorite(favorite.path, at);
    else onAddFavorite(favorite, at);
  };

  return (
    <nav className="sidebar">
      {/* Doubles as the drag region under the traffic lights. */}
      <div className="sidebar-head" data-tauri-drag-region="deep">
        <span className="sidebar-mark">
          <SparkIcon size={15} />
        </span>
        <span className="sidebar-wordmark">Fiddler</span>
      </div>

      <SidebarHeading>Places</SidebarHeading>
      {places.map((place) => (
        <PlaceButton key={place.path} place={place} active={place.path === current} onPick={onPick} />
      ))}

      <div className="sidebar-favorites">
        <SidebarHeading icon={<HeartIcon size={13} />}>Favorites</SidebarHeading>
        <div
          className={`favorites-list ${dropIndex === 0 && favorites.length === 0 ? "drop-before" : ""}`}
          onDragOver={(event) => {
            if (event.target === event.currentTarget) void allowFavoriteDrop(event, favorites.length);
          }}
          onDrop={(event) => dropFavorite(event, favorites.length)}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearDrop();
          }}
        >
          {favorites.map((favorite, index) => (
            <FavoriteButton
              key={favorite.path}
              favorite={favorite}
              active={favorite.path === current}
              before={dropIndex === index}
              after={dropIndex === favorites.length && index === favorites.length - 1}
              onPick={onPick}
              onRemove={onRemoveFavorite}
              onDragStart={() => setDraggingFavorite(true)}
              onDragEnd={() => {
                setDraggingFavorite(false);
                clearDrop();
              }}
              onDragOver={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                const at = index + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0);
                void allowFavoriteDrop(event, at);
              }}
              onDrop={(event) => {
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                const at = index + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0);
                dropFavorite(event, at);
              }}
            />
          ))}
          {favorites.length === 0 && <div className="favorites-empty">Drag a folder here</div>}
        </div>

        {draggingFavorite && (
          <div
            className="favorite-remove"
            onDragOver={(event) => {
              if (dragKind(event) !== "favorite") return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.preventDefault();
              const favorite = favoriteFrom(event, FAVORITE_DRAG_TYPE);
              if (favorite) onRemoveFavorite(favorite.path);
              setDraggingFavorite(false);
              clearDrop();
            }}
          >
            Drop here to remove from Favorites
          </div>
        )}
      </div>
    </nav>
  );
}

function SidebarHeading({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="sidebar-title">
      {icon}
      {children}
    </div>
  );
}

function PlaceButton({ place, active, onPick }: { place: Place; active: boolean; onPick: (path: string) => void }) {
  const Icon = placeIcon[place.icon] ?? FolderIcon;
  return (
    <button
      className={`place ${active ? "active" : ""}`}
      onClick={() => onPick(place.path)}
      title={place.path}
    >
      <span className="place-icon">
        <Icon size={18} />
      </span>
      <span className="place-label">{place.name}</span>
    </button>
  );
}

function FavoriteButton({
  favorite,
  active,
  before,
  after,
  onPick,
  onRemove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  favorite: Favorite;
  active: boolean;
  before: boolean;
  after: boolean;
  onPick: (path: string) => void;
  onRemove: (path: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={`favorite-slot ${before ? "drop-before" : ""} ${after ? "drop-after" : ""}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(FAVORITE_DRAG_TYPE, JSON.stringify(favorite));
        event.dataTransfer.setData("text/plain", favorite.path);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button className={`place favorite ${active ? "active" : ""}`} onClick={() => onPick(favorite.path)} title={favorite.path}>
        <span className="place-icon">
          <FolderIcon size={18} />
        </span>
        <span className="place-label">{favorite.name}</span>
      </button>
      <button
        className="favorite-remove-button"
        aria-label={`Remove ${favorite.name} from Favorites`}
        title="Remove from Favorites"
        onClick={(event) => {
          event.stopPropagation();
          onRemove(favorite.path);
        }}
      >
        <CloseIcon size={13} />
      </button>
    </div>
  );
}
