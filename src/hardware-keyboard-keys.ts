export type HardwareKeyIntent = "open" | "delete" | "rename" | "context-menu";

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  keyCode?: number;
}

/**
 * Turn the physical keys people expect in an Android desktop session into
 * Fiddler-level intents. Keeping this tiny and DOM-free makes the odd key names
 * emitted by different DeX/WebView generations cheap to test.
 */
export function androidHardwareIntent(event: KeyLike): HardwareKeyIntent | null {
  const commandModifier = !!event.ctrlKey || !!event.metaKey || !!event.altKey;

  if (!commandModifier && event.shiftKey && (event.key === "F10" || event.code === "F10")) {
    return "context-menu";
  }
  if (commandModifier || event.shiftKey) return null;

  if (event.key === "Enter" || event.code === "Enter" || event.code === "NumpadEnter") return "open";
  if (
    event.key === "Delete" ||
    event.key === "Del" ||
    event.code === "Delete" ||
    event.keyCode === 46
  ) {
    return "delete";
  }
  if (event.key === "F2" || event.code === "F2") return "rename";
  if (event.key === "ContextMenu" || event.key === "Menu" || event.code === "ContextMenu") {
    return "context-menu";
  }
  return null;
}
