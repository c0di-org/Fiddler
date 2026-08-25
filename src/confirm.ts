/**
 * A confirmation that is Fiddler's own, because `window.confirm` isn't.
 *
 * In wry's Android WebView the JS dialog hooks are version-dependent: where
 * `onJsConfirm` isn't wired, `confirm()` returns `false` synchronously and a
 * touch delete silently never happens. A real `<dialog>` also does what the
 * blocking call never could — it can be styled, it names the dangerous button,
 * and Enter lands on the action the person just asked for while Escape and a
 * click outside still mean no.
 *
 * `role="alertdialog"` + `aria-modal` are load-bearing beyond screen readers:
 * the hardware-keyboard adapter's BLOCKING_OVERLAY selector matches them, so
 * the file view's shortcuts go quiet while the question is up.
 */
export interface ConfirmAsk {
  title: string;
  detail: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

export function confirmDialog(ask: ConfirmAsk): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = document.createElement("dialog");
    dialog.className = "hardware-confirm";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "fiddler-confirm-title");
    dialog.setAttribute("aria-describedby", "fiddler-confirm-detail");

    const copy = document.createElement("div");
    copy.className = "hardware-confirm-copy";
    const title = document.createElement("h2");
    title.id = "fiddler-confirm-title";
    title.textContent = ask.title;
    const detail = document.createElement("p");
    detail.id = "fiddler-confirm-detail";
    detail.textContent = ask.detail;
    copy.append(title, detail);

    const actions = document.createElement("div");
    actions.className = "hardware-confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = ask.cancelLabel ?? "Cancel";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = ask.confirmLabel;
    if (ask.danger) confirm.className = "danger";
    actions.append(cancel, confirm);

    dialog.append(copy, actions);

    let settled = false;
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      previous?.focus({ preventScroll: true });
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
    // A click on the backdrop is the tap-outside every sheet already honours.
    // The backdrop's clicks *target the dialog element*, so the rect check is
    // what tells them apart from a click on the dialog's own edge.
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside =
        event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      if (!inside) finish(false);
    });

    document.body.append(dialog);
    dialog.showModal();
    // The action is the explicit default: the person just asked for it, so a
    // physical Enter confirms, while Tab still reaches Cancel.
    requestAnimationFrame(() => confirm.focus({ preventScroll: true }));
  });
}
