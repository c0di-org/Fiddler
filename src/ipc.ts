/** The app's view of its backend.
 *
 * Every call the UI makes goes through here, and `@backend` is resolved by Vite
 * to either `backend/tauri.ts` or `backend/web.ts` depending on which target is
 * being built. See `backend/types.ts` for what the two owe each other.
 *
 * These are destructured rather than wrapped, which is safe because both
 * implementations are plain objects of arrow functions — no member may depend
 * on `this`. */

import backend from "@backend";

export const {
  listDir,
  nearbyEntries,
  searchContents,
  inspect,
  folderPeek,
  readText,
  repoInfo,
  refreshRepo,
  onRepoStatus,
  sidebarPlaces,
  nearbyDevices,
  nearbyPairingInfo,
  pairNearbyDevice,
  nearbyRequests,
  respondNearbyRequest,
  nearbyAccess,
  withdrawNearbyDevice,
  forgetNearbyDevice,
  usbDevices,
  onUsbDevices,
  onUsbEntries,
  releaseUsbDevice,
  volumes,
  onVolumes,
  ejectVolume,
  createFolder,
  createTextFile,
  writeTextFile,
  renamePath,
  copyPaths,
  movePaths,
  cancelTransfer,
  onTransfer,
  trashPaths,
  restoreTrashed,
  onDirsChanged,
  thumbnail,
  thumbnails,
  onThumbs,
  pdfMeta,
  pdfPage,
  fileSrc,
  mediaUrl,
  systemAccent,
  revealInFinder,
  openTerminalHere,
  openExternal,
  hasOpenHandler,
  installApk,
  takeIncomingFiles,
  onIncomingFile,
  setBackEnabled,
  onBack,
  openFolder,
  importDropped,
} = backend;
