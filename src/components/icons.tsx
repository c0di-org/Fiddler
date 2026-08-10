/** Hand-rolled inline SVGs — a dozen glyphs isn't worth an icon dependency. */

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
const CodeIcon = stroked(
  <>
    <path d="M5.5 5 2.5 8l3 3" />
    <path d="M10.5 5l3 3-3 3" />
  </>
);
const DownloadIcon = stroked(
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

/** Link speed. Shown when a device negotiated USB 2.0 or slower. */
export const BoltIcon = stroked(<path d="M9 1.75 3.75 9h3.5l-.75 5.25L12.25 7h-3.5Z" />);

/** A removable storage, so an SD card doesn't read as a second phone. */
export const SdCardIcon = stroked(
  <>
    <path d="M4 1.75h5.4L12 4.4v9.85H4Z" />
    <path d="M6.4 3.6v2M8 3.6v2M9.6 3.6v2" />
  </>
);

export const LaptopIcon = stroked(
  <>
    <rect x="2.75" y="3" width="10.5" height="7.25" rx=".9" />
    <path d="M1.75 12.5h12.5" />
  </>
);

export const CloseIcon = stroked(<path d="m4.25 4.25 7.5 7.5m0-7.5-7.5 7.5" />);

/** Empty-state artwork: an open, and pointedly empty, folder. */
export const EmptyIcon = stroked(
  <>
    <path d="M2.25 12V4.5a1 1 0 0 1 1-1h3.1l1.4 1.75h5.05a1 1 0 0 1 1 1V7.5" />
    <path d="M2.25 12 4 7.75h11.25L13.5 12a1 1 0 0 1-.95.75H3.2A1 1 0 0 1 2.25 12Z" />
  </>
);

export const placeIcon: Record<string, (p: P) => React.ReactElement> = {
  home: HomeIcon,
  code: CodeIcon,
  desktop: DesktopIcon,
  doc: DocIcon,
  download: DownloadIcon,
  device: DeviceIcon,
};
