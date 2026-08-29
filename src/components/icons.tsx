/** Hand-rolled inline SVGs — a dozen glyphs isn't worth an icon dependency. */

import { LINK_MARKS, type LinkKind } from "../preview/link";

interface P {
  size?: number;
  className?: string;
}

const stroked = (path: React.ReactNode) =>
  function Icon({ size = 14, className }: P) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  };

/** Solid glyphs. Transport controls read as shapes rather than outlines —
 * a stroked triangle at 14px is a smudge, and these are pressed in the dark. */
const filled = (path: React.ReactNode) =>
  function Icon({ size = 14, className }: P) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="currentColor"
        className={className}
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  };

export const Chevron = stroked(<path d="M6 3.5 10.5 8 6 12.5" />);
export const ChevronLeft = stroked(<path d="M10 3.5 5.5 8 10 12.5" />);
export const GripIcon = stroked(
  <>
    <path d="M5.5 4h.01M10.5 4h.01M5.5 8h.01M10.5 8h.01M5.5 12h.01M10.5 12h.01" strokeWidth="2.5" />
  </>
);

export const FolderIcon = stroked(
  <path d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3l1.5 1.75H13a1.25 1.25 0 0 1 1.25 1.25v6A1.25 1.25 0 0 1 13 13.25H3A1.25 1.25 0 0 1 1.75 12z" />
);

export const FolderPlusIcon = stroked(
  <>
    <path d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3l1.5 1.75H13a1.25 1.25 0 0 1 1.25 1.25v6A1.25 1.25 0 0 1 13 13.25H3A1.25 1.25 0 0 1 1.75 12z" />
    <path d="M8 7.25v4M6 9.25h4" />
  </>
);

export const ForkIcon = stroked(
  <>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="11.5" cy="3.5" r="1.5" />
    <circle cx="8" cy="12.5" r="1.5" />
    <path d="M4.5 5v1.5A2 2 0 0 0 6.5 8.5h3a2 2 0 0 0 2-2V5" />
    <path d="M8 8.5v2.5" />
  </>
);

export const LockIcon = stroked(
  <>
    <rect x="3.75" y="7" width="8.5" height="6.25" rx="1.25" />
    <path d="M5.75 7V5a2.25 2.25 0 0 1 4.5 0v2" />
  </>
);

export const WarnIcon = stroked(
  <>
    <path d="M8 2.75 14.5 13.5h-13z" />
    <path d="M8 6.75v3" />
    <path d="M8 11.6h.01" />
  </>
);

export const GridIcon = stroked(
  <>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
  </>
);

export const ListIcon = stroked(
  <>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </>
);

export const PanelIcon = stroked(
  <>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M10 3v10" />
  </>
);

export const SearchIcon = stroked(
  <>
    <circle cx="7.25" cy="7.25" r="4.25" />
    <path d="m10.5 10.5 3 3" />
  </>
);

export const EyeIcon = stroked(
  <>
    <path d="M1.5 8S4 3.75 8 3.75 14.5 8 14.5 8 12 12.25 8 12.25 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="1.9" />
  </>
);

export const UpIcon = stroked(
  <>
    <path d="M8 13V3.5" />
    <path d="M4.25 7.25 8 3.5l3.75 3.75" />
  </>
);

export const NewFileIcon = stroked(
  <>
    <path d="M3.5 2.5h5l4 4v7A1.5 1.5 0 0 1 11 15H3.5A1.5 1.5 0 0 1 2 13.5V4A1.5 1.5 0 0 1 3.5 2.5Z" />
    <path d="M8.5 2.5v4h4" />
    <path d="M7.25 9v4M5.25 11h4" />
  </>
);

const HomeIcon = stroked(<path d="M2.5 7 8 2.5 13.5 7v6a.75.75 0 0 1-.75.75h-9A.75.75 0 0 1 3 13z" />);
export const CodeIcon = stroked(
  <>
    <path d="M5.5 5 2.5 8l3 3" />
    <path d="M10.5 5l3 3-3 3" />
  </>
);
export const DownloadIcon = stroked(
  <>
    <path d="M8 2.5v7" />
    <path d="M5 6.75 8 9.75l3-3" />
    <path d="M3 12.5h10" />
  </>
);
const DocIcon = stroked(
  <>
    <path d="M3.75 2.25h5l3.5 3.5v8a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5Z" />
    <path d="M8.75 2.25v3.5h3.5" />
  </>
);
const DesktopIcon = stroked(
  <>
    <rect x="2" y="3" width="12" height="8" rx="1" />
    <path d="M6 13.5h4" />
  </>
);

export const BranchIcon = stroked(
  <>
    <circle cx="4.5" cy="4" r="1.6" />
    <circle cx="4.5" cy="12.5" r="1.6" />
    <circle cx="11.5" cy="4" r="1.6" />
    <path d="M4.5 5.6v5.3" />
    <path d="M11.5 5.6v1.15a2.5 2.5 0 0 1-2.5 2.5H4.5" />
  </>
);

/** The app's own mark: a tuning fork, for a browser called Fiddler. */
export const SparkIcon = stroked(
  <>
    <path d="M4.5 2v4.5a3.5 3.5 0 0 0 7 0V2" />
    <path d="M8 10v4" />
  </>
);

export const HeartIcon = stroked(
  <path d="M8 13.1 3.1 8.4A3.3 3.3 0 0 1 7.8 3.8L8 4l.2-.2a3.3 3.3 0 0 1 4.7 4.6Z" />
);

export const DeviceIcon = stroked(
  <>
    <rect x="4.5" y="1.75" width="7" height="12.5" rx="1.4" />
    <path d="M7 11.7h2" />
  </>
);

/** The cable itself, heading the section for devices that arrived over one. */
export const CableIcon = stroked(
  <>
    <path d="M2.5 13.5 6 10" />
    <path d="M10 6l3.5-3.5" />
    <rect x="5.4" y="5.4" width="5.2" height="5.2" rx="1.2" transform="rotate(45 8 8)" />
  </>
);

/** The other way a device gets here. Paired with `CableIcon` rather than drawn
 * on its own: the two are only ever shown to tell one kind of device from the
 * other, so they have to read as a pair at 13px. */
export const WifiIcon = stroked(
  <>
    <path d="M1.9 5.6a8.6 8.6 0 0 1 12.2 0" />
    <path d="M4.4 8.4a5 5 0 0 1 7.2 0" />
    <path d="M6.9 11.2a1.6 1.6 0 0 1 2.2 0" />
  </>
);

/** Link speed. Shown when a device negotiated USB 2.0 or slower. */
export const BoltIcon = stroked(<path d="M9 1.75 3.75 9h3.5l-.75 5.25L12.25 7h-3.5Z" />);

/** A removable storage, so an SD card doesn't read as a second phone. */
export const SdCardIcon = stroked(
  <>
    <path d="M4 1.75h5.4L12 4.4v9.85H4Z" />
    <path d="M6.4 3.6v2M8 3.6v2M9.6 3.6v2" />
  </>
);

/** A disk you can unplug: the external drive, and the default for a volume.
 *
 * Drawn as a case with a status light rather than as a platter, because what it
 * has to say is "a box on your desk with a cable", and half the things it
 * stands for — a stick, an SSD — have no platter in them. */
export const DriveIcon = stroked(
  <>
    <rect x="1.75" y="4.25" width="12.5" height="7.5" rx="1.4" />
    <path d="M4.4 8h.01" strokeWidth="2.2" />
    <path d="M7.5 8h4.25" />
  </>
);

/** A mounted `.dmg`: a disk drawn as the file it really is. */
export const DiskImageIcon = stroked(
  <>
    <path d="M3.25 1.75h6l3 3v9.5h-9.5V2.75a1 1 0 0 1 1-1Z" />
    <path d="M9 1.9V4.6a.6.6 0 0 0 .6.6h2.5" />
    <circle cx="7.6" cy="9.6" r="2.1" />
  </>
);

/** A volume that lives on another machine. Distinct from `WifiIcon`, which
 * means a Fiddler peer: a share is a disk you have mounted, not a device you
 * have paired with, and the two sit in different sidebar sections. */
export const NetworkDriveIcon = stroked(
  <>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.9 8h12.2" />
    <path d="M8 1.75a10 10 0 0 1 0 12.5a10 10 0 0 1 0-12.5Z" />
  </>
);

/** Put this volume away. The triangle-over-a-bar every desktop has used for
 * thirty years, which is the entire argument for it. */
export const EjectIcon = stroked(
  <>
    <path d="M8 2.75 13 9.5H3Z" />
    <path d="M3.5 12.75h9" />
  </>
);

export const LaptopIcon = stroked(
  <>
    <rect x="2.75" y="3" width="10.5" height="7.25" rx=".9" />
    <path d="M1.75 12.5h12.5" />
  </>
);

export const CloseIcon = stroked(<path d="m4.25 4.25 7.5 7.5m0-7.5-7.5 7.5" />);

/* A box with something leaving it upward — the same shape Android and macOS
   both draw for their share sheets, so it needs no label to be recognised. */
export const ShareIcon = stroked(
  <>
    <path d="M8 10.25V1.75" />
    <path d="M5 4.75 8 1.75l3 3" />
    <path d="M3.75 7.5h-1v6.75h10.5V7.5h-1" />
  </>
);

/* Two pages, offset — the shape every desktop has used for Copy for decades. */
export const CopyIcon = stroked(
  <>
    <rect x="5.75" y="5.75" width="7.5" height="8.5" rx="1.1" />
    <path d="M10.5 3.75a1.1 1.1 0 0 0-1.1-1H3.85a1.1 1.1 0 0 0-1.1 1.1v7.4a1.1 1.1 0 0 0 1 1.05" />
  </>
);

export const TrashIcon = stroked(
  <>
    <path d="M2.75 4.25h10.5" />
    <path d="M6.25 4.25V2.9h3.5v1.35" />
    <path d="M3.9 4.25 4.5 13a.9.9 0 0 0 .9.85h5.2a.9.9 0 0 0 .9-.85l.6-8.75" />
  </>
);

/* The overflow: the whole menu, one tap away, in the same place every time. */
export const MoreIcon = stroked(
  <>
    <circle cx="3.25" cy="8" r=".85" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r=".85" fill="currentColor" stroke="none" />
    <circle cx="12.75" cy="8" r=".85" fill="currentColor" stroke="none" />
  </>
);

/* The reader's four toggles. Each pair draws the state you'd be going *to*,
   which is what makes one button read as a switch rather than as a label. */

export const ExpandIcon = stroked(
  <path d="M6.25 2.25H2.25v4M9.75 2.25h4v4M6.25 13.75H2.25v-4M9.75 13.75h4v-4" />
);

export const ShrinkIcon = stroked(
  <path d="M2.5 6.25h4v-4M13.5 6.25h-4v-4M2.5 9.75h4v4M13.5 9.75h-4v4" />
);

/** Two pages, opened out. */
export const SpreadIcon = stroked(
  <>
    <path d="M1.75 3.25h5.5v9.5h-5.5zM8.75 3.25h5.5v9.5h-5.5z" />
  </>
);

/** One page, centred. */
export const SinglePageIcon = stroked(<path d="M4.5 2.75h7v10.5h-7z" />);

/** Fill the width: a page with arrows pushing at its sides. */
export const PageWidthIcon = stroked(
  <>
    <path d="M5.25 3.5h5.5v9h-5.5z" />
    <path d="M3 6 1.25 8 3 10M13 6l1.75 2L13 10" />
  </>
);

/** Fit the page: arrows pulling it back inside the frame. */
export const PageFitIcon = stroked(
  <>
    <path d="M4.5 3.25h7v9.5h-7z" />
    <path d="M1.5 8h1.75M12.75 8h1.75M8 1.25V3M8 13v1.75" />
  </>
);

/** A book, for the verb that opens one. */
export const BookIcon = stroked(
  <>
    <path d="M8 4.25C6.75 3.1 5.2 2.75 2.5 2.75v9c2.7 0 4.25.35 5.5 1.5 1.25-1.15 2.8-1.5 5.5-1.5v-9c-2.7 0-4.25.35-5.5 1.5Z" />
    <path d="M8 4.25v9" />
  </>
);

// ------------------------------------------------------- the image editor
//
// One tool, one glyph, all drawn on the same 16-unit grid as everything above
// so the strip reads as a set rather than as a collection.

/** The pointer that picks things up rather than drawing them. */
export const PointerIcon = stroked(<path d="M3.75 2.25 12 7.5l-3.4.9L10 12.4l-1.6.7-1.4-4.1-2.6 2.2z" />);

/** Marquee: the dashed rectangle of a selection you drag out yourself. */
export const MarqueeIcon = function MarqueeIcon({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M2.75 2.75h3M10.25 2.75h3M13.25 2.75v3M13.25 10.25v3M13.25 13.25h-3M5.75 13.25h-3M2.75 13.25v-3M2.75 5.75v-3" />
    </svg>
  );
};

/** The wand, with the sparkle that says it decides for itself what to take. */
export const WandIcon = stroked(
  <>
    <path d="m3 13 7-7" />
    <path d="M9.25 6.75 11.5 9" />
    <path d="M11.75 2.25v2.5M13 3.5h-2.5M12.75 7.25v1.5M13.5 8h-1.5" />
  </>
);

/** Crop marks. */
export const CropIcon = stroked(
  <>
    <path d="M4.75 1.5v9.75h9.75" />
    <path d="M1.5 4.75h9.75V14.5" />
  </>
);

/** A nib, for freehand. */
export const PenIcon = stroked(
  <>
    <path d="M11.5 1.75 14.25 4.5 5.5 13.25 2 14l.75-3.5z" />
    <path d="m9.75 3.5 2.75 2.75" />
  </>
);

/** A chisel tip: the highlighter is a different pen and looks like one. */
export const HighlightIcon = stroked(
  <>
    <path d="M9.5 2.25 13.75 6.5l-5.5 5.5H4.5L3 10.5z" />
    <path d="M2 14.25h12" />
  </>
);

/** Shapes, overlapping, for the tool that draws them. */
export const ShapesIcon = stroked(
  <>
    <path d="M2.25 6.25h6.5v7.5h-6.5z" />
    <circle cx="10.25" cy="5.75" r="3.5" />
  </>
);

/** A letter, for the text box. */
export const TextIcon = stroked(<path d="M3.25 3.25h9.5M8 3.25v9.5M5.75 12.75h4.5" />);

/** A quarter turn, each way. */
export const RotateRightIcon = stroked(
  <>
    <path d="M13 7.5a5 5 0 1 1-1.6-3.65" />
    <path d="M13.5 1.5v3.25h-3.25" />
  </>
);
export const RotateLeftIcon = stroked(
  <>
    <path d="M3 7.5a5 5 0 1 0 1.6-3.65" />
    <path d="M2.5 1.5v3.25h3.25" />
  </>
);

/** Mirrors: a shape and its reflection across a dashed axis. */
export const FlipHIcon = function FlipHIcon({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8 1.75v12.5" strokeDasharray="2 2" />
      <path d="M6.25 3.75 2 8l4.25 4.25zM9.75 3.75 14 8l-4.25 4.25z" />
    </svg>
  );
};
export const FlipVIcon = function FlipVIcon({ size = 14, className }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M1.75 8h12.5" strokeDasharray="2 2" />
      <path d="M3.75 6.25 8 2l4.25 4.25zM3.75 9.75 8 14l4.25-4.25z" />
    </svg>
  );
};

/** Arrows meeting a boundary: the resize dialogue. */
export const ResizeIcon = stroked(
  <>
    <path d="M2.25 2.25h5.5v5.5h-5.5z" />
    <path d="M9.5 9.5h4.25v4.25H9.5z" />
    <path d="m8.5 8.5 1.75-1.75M8.5 8.5 6.75 10.25" />
  </>
);

/** A step back. */
export const UndoIcon = stroked(
  <>
    <path d="M2.5 7.25h7.25a3.75 3.75 0 0 1 0 7.5H6" />
    <path d="M5.5 4 2.25 7.25 5.5 10.5" />
  </>
);

/** A downward arrow into a tray: Save. */
export const SaveIcon = stroked(
  <>
    <path d="M8 1.75v8.5" />
    <path d="M4.75 7 8 10.25 11.25 7" />
    <path d="M2.5 12.25v1.5a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-1.5" />
  </>
);

/** An eraser, for the verb that takes the selection away. */
export const EraseIcon = stroked(
  <>
    <path d="M6.5 13.25 2.25 9l6-6L12.5 7.25l-6 6z" />
    <path d="M13.75 13.25h-7.5M4.5 6.75 8.75 11" />
  </>
);

/** A paint bucket, for the verb that puts colour there instead. */
export const FillIcon = stroked(
  <>
    <path d="M7 1.75 12.75 7.5 7.25 13 1.5 7.25z" />
    <path d="M13.75 10.25c.75 1 1.25 1.7 1.25 2.35a1.25 1.25 0 0 1-2.5 0c0-.65.5-1.35 1.25-2.35Z" />
  </>
);

/** Empty-state artwork: an open, and pointedly empty, folder. */
export const EmptyIcon = stroked(
  <>
    <path d="M2.25 12V4.5a1 1 0 0 1 1-1h3.1l1.4 1.75h5.05a1 1 0 0 1 1 1V7.5" />
    <path d="M2.25 12 4 7.75h11.25L13.5 12a1 1 0 0 1-.95.75H3.2A1 1 0 0 1 2.25 12Z" />
  </>
);

/** A shortcut's destination, drawn from the shared path data in `preview/link`
 * so the glyph and the web build's thumbnail are the same picture. */
// ------------------------------------------------------------------- playback

export const PlayIcon = filled(<path d="M4.5 2.9v10.2a.6.6 0 0 0 .92.5l8-5.1a.6.6 0 0 0 0-1l-8-5.1a.6.6 0 0 0-.92.5Z" />);
export const PauseIcon = filled(
  <path d="M4.25 2.5h2.2a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5h-2.2a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Zm5.3 0h2.2a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5h-2.2a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" />
);
export const PrevTrackIcon = filled(
  <path d="M4 3.2v9.6a.5.5 0 0 0 1 0V8.9l6.2 3.95a.5.5 0 0 0 .8-.42V3.57a.5.5 0 0 0-.8-.42L5 7.1V3.2a.5.5 0 0 0-1 0Z" />
);
export const NextTrackIcon = filled(
  <path d="M12 3.2v9.6a.5.5 0 0 1-1 0V8.9l-6.2 3.95a.5.5 0 0 1-.8-.42V3.57a.5.5 0 0 1 .8-.42L11 7.1V3.2a.5.5 0 0 1 1 0Z" />
);
export const MoonIcon = stroked(
  <path d="M13.2 9.6A5.4 5.4 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />
);
export const SpeedIcon = stroked(
  <>
    <path d="M2.6 12a6 6 0 1 1 10.8 0" />
    <path d="M8 8.6 10.8 6" />
  </>
);
export const HeadphonesIcon = stroked(
  <>
    <path d="M3 10.5V8a5 5 0 0 1 10 0v2.5" />
    <path d="M3 9.75h1.25a.75.75 0 0 1 .75.75v2a.75.75 0 0 1-.75.75H3.5A1.5 1.5 0 0 1 2 11.75v-.5a1.5 1.5 0 0 1 1-1.5Zm10 0h-1.25a.75.75 0 0 0-.75.75v2a.75.75 0 0 0 .75.75h.75a1.5 1.5 0 0 0 1.5-1.5v-.5a1.5 1.5 0 0 0-1-1.5Z" />
  </>
);
export const CheckIcon = stroked(<path d="M3.5 8.5 6.5 11.5 12.5 5" />);
export const QueueIcon = stroked(
  <>
    <path d="M2.5 4h11M2.5 7.5h11M2.5 11h6" />
    <path d="M11.4 10 14 11.6l-2.6 1.6z" fill="currentColor" stroke="none" />
  </>
);

/**
 * The two skip buttons, which carry their own interval.
 *
 * A bare arrow is ambiguous — every player picks a different number, and the
 * one that matters here is the one *this* player is set to. Drawing the digits
 * inside the arc is what every audiobook app converged on, and it is worth the
 * bespoke glyph: these are the two controls that get pressed most.
 */
export function SkipIcon({ seconds, back, size = 22 }: { seconds: number; back?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="skip-icon"
      aria-hidden="true"
      style={back ? { transform: "scaleX(-1)" } : undefined}
    >
      <path d="M12 4.6a7.4 7.4 0 1 0 7.02 5.06" />
      <path d="M13.9 1.9 19.6 4.8 16.4 8.9" />
      <text
        x="12"
        y="15.6"
        textAnchor="middle"
        fontSize="8.2"
        fontWeight="600"
        fill="currentColor"
        stroke="none"
        // The arc is mirrored for the back button; the number must not be.
        transform={back ? "scale(-1,1) translate(-24,0)" : undefined}
      >
        {seconds}
      </text>
    </svg>
  );
}

export function LinkMark({ kind, size = 14, className }: P & { kind: LinkKind }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {LINK_MARKS[kind].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export const placeIcon: Record<string, (p: P) => React.ReactElement> = {
  home: HomeIcon,
  code: CodeIcon,
  desktop: DesktopIcon,
  doc: DocIcon,
  download: DownloadIcon,
  device: DeviceIcon,
};
