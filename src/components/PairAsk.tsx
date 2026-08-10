import type { PairRequest } from "../types";
import { DeviceIcon, LaptopIcon } from "./icons";

/**
 * Another device asking to browse this one.
 *
 * This card is the whole of Fiddler's consent model, which is why it says what
 * it says. Being visible on the network authorises nothing — a broadcast is
 * trivial to forge on shared Wi-Fi — so the only thing that ever opens this
 * machine's files to another is somebody reading this and tapping Allow.
 *
 * It therefore names what is being handed over rather than asking a vague
 * "allow this device?", and Not now is the resting position: it's the wider
 * button, it's what Escape does, and it's what happens if the card is ignored
 * until the ask times out.
 *
 * It deliberately does not take focus. An ask arrives unannounced, possibly
 * mid-sentence in the search field, and a card that grabs the caret would turn
 * the next keystroke into an answer to a question that hadn't been read yet.
 */
export function PairAsk({
  request,
  waiting,
  onRespond,
}: {
  request: PairRequest;
  /** How many others are queued behind this one. */
  waiting: number;
  onRespond: (allow: boolean) => void;
}) {
  const phone = request.platform === "android";

  return (
    <section
      className="pair-ask"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="pair-ask-title"
      aria-describedby="pair-ask-detail"
      onKeyDown={(event) => event.key === "Escape" && onRespond(false)}
    >
      <span className="pair-ask-icon">{phone ? <DeviceIcon size={19} /> : <LaptopIcon size={19} />}</span>
      <div className="pair-ask-body">
        <strong id="pair-ask-title">{request.name} wants to browse this device</strong>
        {/* Accurate about the duration, which is the part people get wrong: the
            token is saved to disk, so this outlives the session. It can now be
            taken back, and saying where turns an open-ended grant into one with
            a visible end. */}
        <span className="pair-ask-detail" id="pair-ask-detail">
          It will be able to read and copy files in your home folder, on this visit and later ones,
          until you withdraw it under Devices.
        </span>
        {waiting > 0 && (
          <span className="pair-ask-queue">
            {waiting} other device{waiting === 1 ? "" : "s"} also asking
          </span>
        )}
      </div>
      <div className="pair-ask-actions">
        <button className="pair-ask-deny" onClick={() => onRespond(false)}>
          Not now
        </button>
        <button className="pair-ask-allow" onClick={() => onRespond(true)}>
          Allow
        </button>
      </div>
    </section>
  );
}
