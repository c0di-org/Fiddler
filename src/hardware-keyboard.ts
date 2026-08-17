import { androidHardwareIntent } from "./hardware-keyboard-keys";
import { platform } from "./platform";

const VIEW = "[data-view-focus]";
const MENU = ".ctx-menu, .ctx-sheet";
const BLOCKING_OVERLAY = '.ql-scrim, .editor-shell, [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

/**
 * Make the Android build behave like a desktop file manager when it is being
 * driven by a physical keyboard in DeX, without changing the touch-first rules
 * or Finder-style shortcuts used by the macOS build.
 *
 * The App already has one authoritative implementation for every operation we
 * need. This adapter only translates Android's desktop keys into those commands:
 * Ctrl+Enter is Open and Ctrl+Backspace is Delete in the existing shortcut
 * layer. Reusing those paths keeps permission checks, undo bookkeeping, error
 * messages and selection cleanup exactly the same as mouse/touch actions.
 */
export function installHardwareKeyboardUX() {
  if (platform !== "android") return;

  let confirmingDelete = false;
  let menuView: HTMLElement | null = null;

  const restoreView = () => {
    const view = menuView?.isConnected ? menuView : document.querySelector<HTMLElement>(VIEW);
    menuView = null;
    view?.focus({ preventScroll: true });
  };

  const closeMenu = (menu: HTMLElement) => {
    const sheet = menu.closest<HTMLElement>(".ctx-scrim");
    if (sheet) sheet.click();
    else window.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    requestAnimationFrame(restoreView);
  };

  const handleOpenMenu = (event: KeyboardEvent, menu: HTMLElement, view: HTMLElement | null) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    if (items.length === 0) return false;

    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (index: number) => items[(index + items.length) % items.length].focus();

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopImmediatePropagation();
        if (view) menuView = view;
        closeMenu(menu);
        return true;
      case "ArrowDown":
        event.preventDefault();
        event.stopImmediatePropagation();
        focusAt(current < 0 ? 0 : current + 1);
        return true;
      case "ArrowUp":
        event.preventDefault();
        event.stopImmediatePropagation();
        focusAt(current < 0 ? items.length - 1 : current - 1);
        return true;
      case "Home":
        event.preventDefault();
        event.stopImmediatePropagation();
        items[0].focus();
        return true;
      case "End":
        event.preventDefault();
        event.stopImmediatePropagation();
        items[items.length - 1].focus();
        return true;
      default:
        return false;
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Synthetic events are how this adapter talks to Fiddler's existing command
    // layer. Ignoring them here prevents the translation from recursively
    // translating itself.
    if (!event.isTrusted) return;

    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const view = active?.matches(VIEW) ? active : null;
    const menu = document.querySelector<HTMLElement>(MENU);

    // A menu opened by right-click leaves focus on the file view underneath.
    // Once a key is pressed, the menu owns arrows/Escape instead, which both
    // makes it keyboard-operable and prevents Escape from also clearing the
    // file selection behind it.
    if (menu && (view || active?.closest(MENU))) {
      if (handleOpenMenu(event, menu, view)) return;
    }

    if (!view || confirmingDelete || document.querySelector(BLOCKING_OVERLAY)) return;

    const intent = androidHardwareIntent(event);
    if (!intent) return;

    if (intent === "open") {
      event.preventDefault();
      event.stopImmediatePropagation();
      dispatchShortcut("Enter", "Enter", { ctrlKey: true });
      return;
    }

    if (intent === "delete") {
      event.preventDefault();
      event.stopImmediatePropagation();
      confirmingDelete = true;
      void confirmPermanentDelete(view).then((confirmed) => {
        confirmingDelete = false;
        if (!confirmed) return;
        // Android has no Trash, so App.trashSelected() asks with window.confirm.
        // The person has just answered that question in the keyboard-native
        // dialog above. Suppress only that one synchronous duplicate prompt,
        // then run the exact existing delete command.
        const nativeConfirm = window.confirm;
        window.confirm = () => true;
        try {
          dispatchShortcut("Backspace", "Backspace", { ctrlKey: true });
        } finally {
          window.confirm = nativeConfirm;
        }
      });
      return;
    }

    if (intent === "rename") {
      // Inline rename only exists in List view. There, Fiddler's existing plain
      // Enter handler is the rename command; keeping F2 as an alias preserves a
      // way to rename after Android's plain Enter is reassigned to Open.
      if (!view.classList.contains("list-view")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      view.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    openContextMenuForCursor(view);
  };

  // A menu item removes itself as it runs, which would otherwise leave focus on
  // <body> and make the next arrow key appear dead. Put the keyboard back in the
  // file view after a keyboard or mouse pick.
  const onClick = (event: MouseEvent) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="menuitem"]');
    if (!item) return;
    menuView = document.querySelector<HTMLElement>(VIEW);
    requestAnimationFrame(restoreView);
  };

  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClick, true);
}

function dispatchShortcut(
  key: string,
  code: string,
  modifiers: Pick<KeyboardEventInit, "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> = {}
) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    })
  );
}

function openContextMenuForCursor(view: HTMLElement) {
  const activeId = view.getAttribute("aria-activedescendant");
  const target = activeId ? document.getElementById(activeId) : view;
  if (!target) return;

  const bounds = target.getBoundingClientRect();
  target.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(bounds.left + Math.min(bounds.width / 2, 28)),
      clientY: Math.round(bounds.top + Math.min(bounds.height / 2, 20)),
    })
  );

  requestAnimationFrame(() => {
    document.querySelector<HTMLButtonElement>(`${MENU} [role="menuitem"]`)?.focus({ preventScroll: true });
  });
}

function confirmPermanentDelete(view: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "hardware-confirm";
    dialog.setAttribute("aria-labelledby", "hardware-confirm-title");
    dialog.setAttribute("aria-describedby", "hardware-confirm-detail");
    dialog.innerHTML = `
      <div class="hardware-confirm-copy">
        <h2 id="hardware-confirm-title">Permanently delete the selected items?</h2>
        <p id="hardware-confirm-detail">Android has no Trash for these files. This cannot be undone.</p>
      </div>
      <div class="hardware-confirm-actions">
        <button type="button" data-cancel>Cancel</button>
        <button type="button" class="danger" data-confirm>Delete</button>
      </div>
    `;

    const cancel = dialog.querySelector<HTMLButtonElement>("[data-cancel]")!;
    const confirm = dialog.querySelector<HTMLButtonElement>("[data-confirm]")!;
    let settled = false;

    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      view.focus({ preventScroll: true });
      resolve(answer);
    };

    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });

    document.body.append(dialog);
    dialog.showModal();
    // Delete is the explicit default once the user has pressed Delete. A
    // physical Enter therefore confirms, while Tab can still move to Cancel and
    // Enter there cancels like an ordinary focused button.
    requestAnimationFrame(() => confirm.focus({ preventScroll: true }));
  });
}
