import { useEffect, useRef, useState } from "react";

import { trackTitle } from "../audio/book";
import * as player from "../audio/player";
import { SKIPS, SPEEDS } from "../audio/player";
import { markFor, progressOf } from "../audio/positions";
import { clock, rateLabel, realRemaining, span } from "../audio/time";
import { useAudioMarks, usePlayer } from "../audio/use-player";
import {
  CheckIcon,
  Chevron,
  HeadphonesIcon,
  MoonIcon,
  NextTrackIcon,
  PauseIcon,
  PlayIcon,
  PrevTrackIcon,
  QueueIcon,
  SkipIcon,
  SpeedIcon,
} from "./icons";
import { Scrubber } from "./Scrubber";

/** Sleep timers, in minutes. `null` is "to the end of this chapter", which is
 * the one everybody actually wants and no timer in minutes can express: a
 * chapter is a natural place to stop, and stopping mid-sentence isn't. */
const TIMERS: (number | null)[] = [5, 10, 15, 30, 45, 60, null];

type Panel = "speed" | "sleep" | "chapters" | null;

interface Props {
  onClose: () => void;
  /** Advances when Android's Back is pressed. A panel closes first; the
   * screen itself is the rung below it. Same idiom as the image editor. */
  closeSignal: number;
}

/**
 * The full player.
 *
 * Everything here is sized for a thumb in the dark, which is the honest
 * description of when an audiobook gets touched: the play button is 76px, the
 * two skips flank it because they are the next most pressed, and the chapter
 * skips sit outside those because pressing one by accident costs you a chapter.
 *
 * The three chips underneath are the settings that a book — as opposed to a
 * song — actually needs. Speed, because narrators vary more than music does.
 * A sleep timer, because a book is the thing people fall asleep to. And the
 * chapter list, because "where am I" is the question a four-hundred-minute
 * recording raises and a three-minute one never does.
 */
export function NowPlaying({ onClose, closeSignal }: Props) {
  const s = usePlayer();
  const marks = useAudioMarks();
  const [panel, setPanel] = useState<Panel>(null);
  const first = useRef(true);
  const panelRef = useRef<Panel>(panel);
  panelRef.current = panel;
  // Read through a ref, and kept out of the effect's dependencies on purpose.
  // The host passes a fresh arrow on every one of its renders, so depending on
  // it would re-run this effect whenever anything at all changed in the folder
  // behind — and re-running it means closing a sheet, or the whole player,
  // that nobody asked to close.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (panelRef.current) setPanel(null);
    else closeRef.current();
  }, [closeSignal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (panelRef.current) setPanel(null);
        else closeRef.current();
        return;
      }
      // Space is play/pause everywhere a player is on screen, and nothing else
      // here scrolls, so nothing else wants it.
      const target = e.target as HTMLElement | null;
      if (e.key === " " && target?.tagName !== "BUTTON") {
        e.preventDefault();
        player.toggle();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Stopping the player from inside the player takes the screen with it. The
  // effect rather than a call at the stop button, because the queue can also
  // empty from underneath this screen — `close()` is reachable from the bar.
  useEffect(() => {
    if (!s.track) closeRef.current();
  }, [s.track]);

  if (!s.track) return null;

  const left = realRemaining(s.at, s.duration, s.rate);
  const chapter = `${s.index + 1} of ${s.queue.length}`;

  return (
    <div className="now-playing" role="dialog" aria-modal="true" aria-label="Now playing">
      <header className="np-head">
        <button type="button" className="np-collapse" onClick={onClose} aria-label="Close the player">
          <Chevron size={18} className="np-chevron-down" />
        </button>
        <div className="np-head-text">
          <span className="np-head-book">{s.book || "Playing"}</span>
          {s.queue.length > 1 && <span className="np-head-chapter">Chapter {chapter}</span>}
        </div>
        <button
          type="button"
          className="np-collapse"
          onClick={() => player.close()}
          aria-label="Stop and close the player"
        >
          <span className="np-stop-dot" />
        </button>
      </header>

      <div className="np-art">
        {s.cover ? (
          <img src={s.cover} alt="" draggable={false} />
        ) : (
          <div className="np-art-blank">
            <HeadphonesIcon size={72} />
          </div>
        )}
      </div>

      <div className="np-titles">
        <h1>{trackTitle(s.track.name)}</h1>
        {s.book && <p>{s.book}</p>}
        {s.error && <p className="np-error">{s.error}</p>}
      </div>

      <div className="np-timeline">
        <Scrubber at={s.at} duration={s.duration} onSeek={player.seekTo} step={s.skipForward} large />
        <div className="np-times">
          <span>{clock(s.at)}</span>
          <span className="np-left">
            {s.duration > 0 ? `${span(left)} left${s.rate !== 1 ? ` at ${rateLabel(s.rate)}` : ""}` : "—"}
          </span>
          <span>{s.duration > 0 ? `−${clock(Math.max(0, s.duration - s.at))}` : "—"}</span>
        </div>
      </div>

      <div className="np-transport">
        <button
          type="button"
          className="np-btn np-chapter"
          onClick={() => player.previous()}
          disabled={s.index === 0 && s.at <= 5}
          aria-label="Previous chapter"
          title="Previous chapter"
        >
          <PrevTrackIcon size={20} />
        </button>
        <button
          type="button"
          className="np-btn np-skip"
          onClick={() => player.skip(-s.skipBack)}
          aria-label={`Back ${s.skipBack} seconds`}
          title={`Back ${s.skipBack} seconds`}
        >
          <SkipIcon seconds={s.skipBack} back size={34} />
        </button>
        <button
          type="button"
          className="np-btn np-play"
          onClick={() => player.toggle()}
          aria-label={s.playing ? "Pause" : "Play"}
          title={s.playing ? "Pause" : "Play"}
        >
          {s.playing ? <PauseIcon size={30} /> : <PlayIcon size={30} />}
        </button>
        <button
          type="button"
          className="np-btn np-skip"
          onClick={() => player.skip(s.skipForward)}
          aria-label={`Forward ${s.skipForward} seconds`}
          title={`Forward ${s.skipForward} seconds`}
        >
          <SkipIcon seconds={s.skipForward} size={34} />
        </button>
        <button
          type="button"
          className="np-btn np-chapter"
          onClick={() => player.next()}
          disabled={s.index + 1 >= s.queue.length}
          aria-label="Next chapter"
          title="Next chapter"
        >
          <NextTrackIcon size={20} />
        </button>
      </div>

      <div className="np-chips">
        <button
          type="button"
          className={`np-chip${panel === "speed" ? " on" : ""}${s.rate !== 1 ? " set" : ""}`}
          onClick={() => setPanel(panel === "speed" ? null : "speed")}
        >
          <SpeedIcon size={14} />
          {rateLabel(s.rate)}
        </button>
        <button
          type="button"
          className={`np-chip${panel === "sleep" ? " on" : ""}${s.sleep ? " set" : ""}`}
          onClick={() => setPanel(panel === "sleep" ? null : "sleep")}
        >
          <MoonIcon size={14} />
          {s.sleep
            ? s.sleep.kind === "chapter"
              ? "End of chapter"
              : span(s.sleep.leftMs / 1000)
            : "Sleep"}
        </button>
        <button
          type="button"
          className={`np-chip${panel === "chapters" ? " on" : ""}`}
          onClick={() => setPanel(panel === "chapters" ? null : "chapters")}
          disabled={s.queue.length < 2}
        >
          <QueueIcon size={14} />
          Chapters
        </button>
      </div>

      {panel === "speed" && (
        <Sheet title="Playback speed" onClose={() => setPanel(null)}>
          <div className="np-speeds">
            {SPEEDS.map((rate) => (
              <button
                key={rate}
                type="button"
                className={`np-speed${Math.abs(rate - s.rate) < 0.001 ? " on" : ""}`}
                onClick={() => player.setRate(rate)}
              >
                {rateLabel(rate)}
              </button>
            ))}
          </div>
          <p className="np-note">Pitch is held steady, so a fast narrator still sounds like one.</p>
          <div className="np-skip-settings">
            <SkipSetting
              label="Skip back"
              value={s.skipBack}
              onPick={(v) => player.setSkips(v, s.skipForward)}
            />
            <SkipSetting
              label="Skip forward"
              value={s.skipForward}
              onPick={(v) => player.setSkips(s.skipBack, v)}
            />
          </div>
        </Sheet>
      )}

      {panel === "sleep" && (
        <Sheet title="Sleep timer" onClose={() => setPanel(null)}>
          <div className="np-speeds">
            {TIMERS.map((mins) => {
              const on =
                mins === null
                  ? s.sleep?.kind === "chapter"
                  : s.sleep?.kind === "in" && Math.round(s.sleep.setMs / 60000) === mins;
              return (
                <button
                  key={mins ?? "chapter"}
                  type="button"
                  className={`np-speed${on ? " on" : ""}`}
                  onClick={() =>
                    player.setSleep(
                      mins === null
                        ? { kind: "chapter" }
                        : { kind: "in", leftMs: mins * 60_000, setMs: mins * 60_000 }
                    )
                  }
                >
                  {mins === null ? "End of chapter" : `${mins} min`}
                </button>
              );
            })}
          </div>
          {s.sleep && (
            <div className="np-sleep-live">
              <button type="button" className="np-speed" onClick={() => player.extendSleep(15 * 60_000)}>
                +15 min
              </button>
              <button type="button" className="np-speed" onClick={() => player.setSleep(null)}>
                Turn off
              </button>
            </div>
          )}
          <p className="np-note">
            The timer counts listening, not clock time — pausing pauses it too — and the last few
            seconds fade out rather than stopping dead.
          </p>
        </Sheet>
      )}

      {panel === "chapters" && (
        <Sheet title={s.book || "Chapters"} onClose={() => setPanel(null)} tall>
          <ol className="np-chapters">
            {s.queue.map((track, i) => {
              const done = progressOf(markFor(marks, track.path));
              return (
                <li key={track.path}>
                  <button
                    type="button"
                    className={`np-chapter-row${i === s.index ? " on" : ""}`}
                    onClick={() => {
                      player.goTo(i);
                      setPanel(null);
                    }}
                  >
                    <span className="np-chapter-n">{i + 1}</span>
                    <span className="np-chapter-name">{trackTitle(track.name)}</span>
                    {done === 1 ? (
                      <CheckIcon size={13} className="np-chapter-done" />
                    ) : done !== null && done > 0 ? (
                      <span className="np-chapter-bar">
                        <span style={{ width: `${Math.round(done * 100)}%` }} />
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </Sheet>
      )}
    </div>
  );
}

function SkipSetting({
  label,
  value,
  onPick,
}: {
  label: string;
  value: number;
  onPick: (seconds: number) => void;
}) {
  return (
    <div className="np-skip-setting">
      <span>{label}</span>
      <div className="np-speeds">
        {SKIPS.map((seconds) => (
          <button
            key={seconds}
            type="button"
            className={`np-speed${seconds === value ? " on" : ""}`}
            onClick={() => onPick(seconds)}
          >
            {seconds}s
          </button>
        ))}
      </div>
    </div>
  );
}

function Sheet({
  title,
  onClose,
  tall,
  children,
}: {
  title: string;
  onClose: () => void;
  tall?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="np-scrim" onClick={onClose} />
      <div className={`np-sheet${tall ? " np-sheet-tall" : ""}`} role="dialog" aria-label={title}>
        <div className="np-sheet-grip" />
        <h2>{title}</h2>
        {children}
      </div>
    </>
  );
}
