import { useSyncExternalStore } from "react";

import { marksSnapshot, snapshot, subscribe, subscribeMarks } from "./player";

/** The player, as React sees it. Two stores rather than one because they change
 * at wildly different rates — see the note above `subscribeMarks`. */
export function usePlayer() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useAudioMarks() {
  return useSyncExternalStore(subscribeMarks, marksSnapshot, marksSnapshot);
}
