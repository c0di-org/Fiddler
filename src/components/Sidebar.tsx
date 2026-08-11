import { useState } from "react";

import { FAVORITE_DRAG_TYPE, FOLDER_DRAG_TYPE, currentFolderDrag } from "../favorites";
import { dropProps, useDropTarget, type DropItems } from "./use-drop-target.ts";
import type { Favorite, PeerDevice, Place, UsbDevice } from "../types";
import { connectionNotice } from "../usb";
import { BoltIcon, CableIcon, CloseIcon, DeviceIcon, FolderIcon, FolderPlusIcon, HeartIcon, LaptopIcon, LockIcon, SparkIcon, WifiIcon, placeIcon } from "./icons";
import { UsbStorageRow } from "./UsbPanel";

interface Props {
  places: Place[];
  favorites: Favorite[];
  current: string;
  onPick: (path: string) => void;
  onAddFavorite: (favorite: Favorite, at?: number) => void;
  onRemoveFavorite: (path: string) => void;
  onMoveFavorite: (path: string, at: number) => void;
  /** The current Android touch drag, if it is over a Favorites drop target. */
  touchFolderDropIndex?: number | null;
  devices: PeerDevice[];
  onOpenDevice: (device: PeerDevice) => void;
  /** The device we are waiting on an answer from, if any. Pairing is two
   * taps, and this is the gap between them. */
  askingDeviceId?: string | null;
  selfDeviceName: string | null;
  /** Devices on the end of a cable. No pairing, so these need no lock state. */
  usb: UsbDevice[];
  onOpenUsb: (device: UsbDevice) => void;
  /** Present only where a folder can be mounted — the web build, in a browser
   * that has the File System Access API. */
  onOpenFolder?: () => void;
  /** Places take a drop of items, which Favorites deliberately doesn't: a
   * favourite is a bookmark, and dragging a folder there means "remember this",
   * not "put this inside it". */
  onDropItems?: DropItems;
  /** How many devices hold access in either direction. Keeps the Over Wi-Fi
   * section — and so the way into the panel — present when a device that was
   * allowed months ago isn't on the network today. */
  accessCount?: number;
  onManageAccess?: () => void;
  /** These devices are a demonstration rather than hardware. True only in the
   * web build, which has neither a USB host nor a network transport — so a row
   * there has to say what it is rather than imply a phone is plugged into a
   * browser tab. */
  simulated?: boolean;
}

type DragKind = "folder" | "favorite";

function dragKind(event: React.DragEvent): DragKind | null {
  const types = event.dataTransfer.types;
  if (Array.from(types).includes(FAVORITE_DRAG_TYPE)) return "favorite";
  if (Array.from(types).includes(FOLDER_DRAG_TYPE)) return "folder";
  return currentFolderDrag() ? "folder" : null;
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
  } catch {}
  return type === FOLDER_DRAG_TYPE ? currentFolderDrag() : null;
}

export function Sidebar({
  places,
  favorites,
  current,
  onPick,
  onAddFavorite,
  onRemoveFavorite,
  onMoveFavorite,
  touchFolderDropIndex = null,
  devices,
  onOpenDevice,
  askingDeviceId,
  selfDeviceName,
  usb,
  onOpenUsb,
  onOpenFolder,
  onDropItems,
  accessCount = 0,
  onManageAccess,
  simulated = false,
}: Props) {
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [draggingFavorite, setDraggingFavorite] = useState(false);
  const visibleDropIndex = touchFolderDropIndex ?? dropIndex;

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
        <PlaceButton
          key={place.path}
          place={place}
          active={place.path === current}
          onPick={onPick}
          onDropItems={onDropItems}
        />
      ))}
      {onOpenFolder && (
        <button className="place place-action" onClick={onOpenFolder} title="Browse a folder from this computer">
          <span className="place-icon">
            <FolderPlusIcon size={18} />
          </span>
          <span className="place-label">Open Folder…</span>
        </button>
      )}

      {usb.length > 0 && (
        <div className="sidebar-devices">
          <SidebarHeading icon={<CableIcon size={13} />}>On a cable</SidebarHeading>
          {usb.map((device) => {
            const notice = connectionNotice(device);
            const open = current.startsWith(`mtp://${device.serial}/`);
            return (
              <div key={device.serial} className="usb-device">
                <button
                  className={`place device ${open && device.storages.length <= 1 ? "active" : ""}`}
                  onClick={() => onOpenUsb(device)}
                  title={notice ? notice.title : `Browse ${device.name} over the cable`}
                >
                  <span className="place-icon">
                    <DeviceIcon size={18} />
                  </span>
                  <span className="place-label">{device.name}</span>
                  {simulated && <span className="device-demo">demo</span>}
                  {device.throttled && device.stage === "ready" && (
                    <BoltIcon size={11} className="usb-slow" />
                  )}
                  {/* How this device got here, on the row rather than only on
                      the heading above it. The same phone can be on the cable
                      and on the network at once, and the two rows are otherwise
                      identical — right down to the glyph. */}
                  <CableIcon size={11} className="device-how" />
                </button>
                {/* The stage sits under the name rather than replacing the row,
                    so the device never disappears while it is still arriving. */}
                {notice && (
                  <div className={`usb-stage ${notice.resolves ? "waiting" : "stopped"}`}>
                    {notice.resolves && <span className="usb-pulse" />}
                    {notice.title}
                  </div>
                )}
                {/* Only worth listing storages when there is a choice to make. */}
                {device.storages.length > 1 &&
                  device.storages.map((storage) => (
                    <UsbStorageRow
                      key={storage.id}
                      device={device}
                      storage={storage}
                      active={current.startsWith(`mtp://${device.serial}/${storage.id}`)}
                      onPick={onPick}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Shown when there is anything to say — a device on the network, or one
          that holds access and isn't here. The second case is the whole reason
          the panel exists, so it must be reachable with nothing in the list. */}
      {(devices.length > 0 || accessCount > 0) && <div className="sidebar-devices">
        <SidebarHeading
          icon={<WifiIcon size={13} />}
          action={
            onManageAccess && (
              <button
                className="sidebar-title-action"
                onClick={onManageAccess}
                title="Devices that have been allowed, and devices this one can browse"
              >
                {accessCount > 0 ? accessCount : ""}
                <LockIcon size={11} />
              </button>
            )
          }
        >
          Over Wi-Fi
        </SidebarHeading>
        {devices.map((device) => {
          const asking = device.id === askingDeviceId;
          return (
            <div key={device.id} className="peer-device">
              <button className={`place device ${current.startsWith(`fiddler://${device.id}/`) ? "active" : ""}`} onClick={() => onOpenDevice(device)} title={device.paired ? "Browse this device over Wi-Fi" : "Ask to browse this device over Wi-Fi"} disabled={asking}>
                <span className="place-icon">{device.platform === "macos" || device.platform === "desktop" ? <LaptopIcon size={18} /> : <DeviceIcon size={18} />}</span>
                <span className="place-label">{device.name}</span>
                {simulated && <span className="device-demo">demo</span>}
                {!device.paired && !asking && <LockIcon size={12} className="device-lock" />}
                <WifiIcon size={11} className="device-how" />
              </button>
              {/* Under the name rather than replacing it, like a cable's stage:
                  the answer is a tap on the other device, so this can sit here
                  for as long as it takes someone to walk over and give it. */}
              {asking && (
                <div className="usb-stage waiting">
                  <span className="usb-pulse" />
                  Waiting for a tap on that device…
                </div>
              )}
            </div>
          );
        })}
        {selfDeviceName && <div className="device-self">This device: {selfDeviceName}</div>}
      </div>}

      <div className="sidebar-favorites">
        <SidebarHeading icon={<HeartIcon size={13} />}>Favorites</SidebarHeading>
        <div
          className={`favorites-list ${visibleDropIndex === 0 && favorites.length === 0 ? "drop-before" : ""}`}
          data-favorites-list
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
              index={index}
              active={favorite.path === current}
              before={visibleDropIndex === index}
              after={visibleDropIndex === favorites.length && index === favorites.length - 1}
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

function SidebarHeading({
  icon,
  action,
  children,
}: {
  icon?: React.ReactNode;
  /** A control belonging to the whole section, pushed to the far end. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="sidebar-title">
      {icon}
      {children}
      {action}
    </div>
  );
}

function PlaceButton({
  place,
  active,
  onPick,
  onDropItems,
}: {
  place: Place;
  active: boolean;
  onPick: (path: string) => void;
  onDropItems?: DropItems;
}) {
  const Icon = placeIcon[place.icon] ?? FolderIcon;
  const drop = useDropTarget(place.path, onDropItems);
  const { className: dropClass, ...dropHandlers } = dropProps(drop);
  return (
    <button
      className={`place ${active ? "active" : ""} ${dropClass}`}
      onClick={() => onPick(place.path)}
      title={place.path}
      {...dropHandlers}
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
  index,
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
  index: number;
}) {
  return (
    <div
      className={`favorite-slot ${before ? "drop-before" : ""} ${after ? "drop-after" : ""}`}
      data-favorite-index={index}
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
