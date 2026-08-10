import type { Favorite } from "./types";

/** Custom drag types keep a folder drag distinct from ordinary text selection. */
export const FOLDER_DRAG_TYPE = "application/x-fiddler-folder";
export const FAVORITE_DRAG_TYPE = "application/x-fiddler-favorite";

const STORAGE_KEY = "fiddler.favorites";

function safeFavorites(value: unknown): Favorite[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as Favorite).name !== "string" ||
      typeof (item as Favorite).path !== "string" ||
      !(item as Favorite).name.trim() ||
      !(item as Favorite).path.trim() ||
      seen.has((item as Favorite).path)
    ) {
      return [];
    }
    const favorite = { name: (item as Favorite).name, path: (item as Favorite).path };
    seen.add(favorite.path);
    return [favorite];
  });
}

export function loadFavorites(): Favorite[] {
  try {
    return safeFavorites(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveFavorites(favorites: Favorite[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    // Browsing must still work when storage is disabled or full.
  }
}

export function addFavorite(favorites: Favorite[], favorite: Favorite, at = favorites.length): Favorite[] {
  const from = favorites.findIndex((item) => item.path === favorite.path);
  const without = favorites.filter((item) => item.path !== favorite.path);
  const index = Math.max(0, Math.min(from >= 0 && from < at ? at - 1 : at, without.length));
  return [...without.slice(0, index), favorite, ...without.slice(index)];
}

export function moveFavorite(favorites: Favorite[], path: string, at: number): Favorite[] {
  const from = favorites.findIndex((favorite) => favorite.path === path);
  if (from < 0) return favorites;
  const favorite = favorites[from];
  const without = favorites.filter((_, index) => index !== from);
  const index = Math.max(0, Math.min(from < at ? at - 1 : at, without.length));
  return [...without.slice(0, index), favorite, ...without.slice(index)];
}
