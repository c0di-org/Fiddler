import * as player from "../audio/player";
import { trackTitle } from "../audio/book";
import { clock, realRemaining, span } from "../audio/time";
import { usePlayer } from "../audio/use-player";
import { CloseIcon, HeadphonesIcon, PauseIcon, PlayIcon, SkipIcon } from "./icons";
import { Scrubber } from "./Scrubber";

/**
 * The bar along the bottom, and the whole reason any of this exists.
 *
 * A file browser that plays audio in its preview pane can only play audio while
 * you are looking at the file — which is to say, never, because listening to a
 * book is something you do while doing something else. This bar is what
 * survives: it is drawn outside the folder view, fed by a module-scope element,
 * and nothing about walking into another folder touches either.
 *
 * Kept deliberately shallow. The bar has the two controls worth having under a
 * thumb without looking — play, and skip back — and everything else is one tap
 * away in the full screen. A bar with nine buttons on it is a bar you have to
 * aim at.
 */
interface Props {
  onOpen: () => void;
}

export function MiniPlayer({ onOpen }: Props) {
  const s = usePlayer();
  if (!s.track) return null;

  const left = realRemaining(s.at, s.duration, s.rate);
  const subtitle = s.error
    ? s.error
    : s.duration > 0
      ? `${s.book ? `${s.book} · ` : ""}${span(left)} left`
      : s.book || clock(s.at);

  return (
    <div className={`mini-player${s.error ? " mini-error" : ""}`}>
      <Scrubber at={s.at} duration={s.duration} onSeek={player.seekTo} step={s.skipForward} />
      <div className="mini-body">
        <button
          type="button"
          className="mini-open"
          onClick={onOpen}
          title="Now playing"
          aria-label={`Now playing: ${trackTitle(s.track.name)}. Open the player.`}
        >
          <span className="mini-art">
            {s.cover ? <img src={s.cover} alt="" draggable={false} /> : <HeadphonesIcon size={20} />}
          </span>
          <span className="mini-text">
            <span className="mini-title">{trackTitle(s.track.name)}</span>
            <span className="mini-sub">{subtitle}</span>
          </span>
        </button>

        <div className="mini-controls">
          <button
            type="button"
            className="mini-btn mini-skip"
            onClick={() => player.skip(-s.skipBack)}
            title={`Back ${s.skipBack} seconds`}
            aria-label={`Back ${s.skipBack} seconds`}
          >
            <SkipIcon seconds={s.skipBack} back size={24} />
          </button>
          <button
            type="button"
            className="mini-btn mini-play"
            onClick={() => player.toggle()}
            title={s.playing ? "Pause" : "Play"}
            aria-label={s.playing ? "Pause" : "Play"}
          >
            {s.playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          </button>
          <button
            type="button"
            className="mini-btn mini-skip mini-wide-only"
            onClick={() => player.skip(s.skipForward)}
            title={`Forward ${s.skipForward} seconds`}
            aria-label={`Forward ${s.skipForward} seconds`}
          >
            <SkipIcon seconds={s.skipForward} size={24} />
          </button>
          <button
            type="button"
            className="mini-btn mini-close mini-wide-only"
            onClick={() => player.close()}
            title="Stop and close the player"
            aria-label="Stop and close the player"
          >
            <CloseIcon size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
