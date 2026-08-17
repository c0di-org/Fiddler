import { extensionOf, fileVisualKind, type FileVisualKind } from "../glyph-category";

interface Props {
  name: string;
  /** Rendered width in CSS pixels; detail is gated on what can actually resolve. */
  size: number;
  /** The bottom of a folder-peek item is hidden by the folder flap. */
  tucked?: boolean;
}

const SHEET = "M12 4h17.5L39 13.5V41a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z";
const FOLD = "M29.5 4 39 13.5h-6.5a3 3 0 0 1-3-3Z";

/**
 * Lightweight fallback artwork. Real thumbnails still win whenever they exist;
 * this is the identity used in dense list rows, while loading, and in folder
 * fans. Every family is made from a handful of paths and reuses the document's
 * shared category gradients.
 */
export function FileArtwork({ name, size, tucked }: Props) {
  const kind = fileVisualKind(name);
  const ext = extensionOf(name);
  const tiny = size < 20;
  const showChip = !tucked && size >= 48 && ext.length > 0 && ext.length <= 5 && kind !== "pdf";

  return (
    <>
      <FamilyArt kind={kind} tiny={tiny} size={size} ext={ext} tucked={!!tucked} />
      {showChip && <TypeChip ext={ext} />}
    </>
  );
}

function FamilyArt({
  kind,
  tiny,
  size,
  ext,
  tucked,
}: {
  kind: FileVisualKind;
  tiny: boolean;
  size: number;
  ext: string;
  tucked: boolean;
}) {
  switch (kind) {
    case "code":
      return (
        <>
          <Sheet />
          <path className="band" d="M9 7a3 3 0 0 1 3-3h3v40h-3a3 3 0 0 1-3-3Z" />
          {!tiny && <path className="lines" style={{ strokeWidth: 2.35 }} d="m22 18-5 6 5 6m7-12 5 6-5 6m-3-15-4 18" />}
        </>
      );
    case "config":
      return (
        <>
          <Sheet />
          <path className="band" d="M9 13.5h30v5H9Z" />
          {!tiny && (
            <path
              className="lines"
              style={{ strokeWidth: 2.15 }}
              d="M16 24h16M16 31h16M16 38h16M21 21v6M28 28v6M23 35v6"
            />
          )}
        </>
      );
    case "data":
      return (
        <>
          <Sheet />
          <path className="band" d="M9 13.5h30v4H9Z" />
          {!tiny && (
            <path
              className="lines"
              style={{ strokeWidth: 1.75 }}
              d="M15 23h18M15 29h18M15 35h18M21 20v18M28 20v18"
            />
          )}
        </>
      );
    case "document":
      return (
        <>
          <Sheet />
          <path className="band" d="M9 13.5h6v27.5a3 3 0 0 1-3 3h0a3 3 0 0 1-3-3Z" />
          {!tiny && !tucked && <path className="lines" d="M19 22h14M19 28h14M19 34h11" />}
        </>
      );
    case "pdf":
      return (
        <>
          <Sheet />
          <path d="M9 15h30v12H9Z" fill="#e5484d" />
          {size >= 22 && (
            <text x="24" y="23.3" textAnchor="middle" className="band-text" style={{ fontSize: 8.4 }}>
              PDF
            </text>
          )}
          {!tiny && !tucked && <path className="lines" d="M15 33h18M15 39h11" />}
        </>
      );
    case "image":
      return (
        <>
          <rect x="6" y="7" width="36" height="34" rx="5" className="sheet-face" />
          <path className="band" d="M6 31 16 21l7 7 5-5 14 13v5H6Z" />
          {!tiny && <circle cx="31.5" cy="16.5" r="4" className="band" />}
        </>
      );
    case "audio":
      return (
        <>
          <rect x="7" y="7" width="34" height="34" rx="8" className="sheet-face" />
          <rect x="12" y="21" width="3.5" height="7" rx="1.75" className="band" />
          <rect x="18" y="16" width="3.5" height="17" rx="1.75" className="band" />
          <rect x="24" y="12" width="3.5" height="25" rx="1.75" className="band" />
          <rect x="30" y="17" width="3.5" height="15" rx="1.75" className="band" />
          <rect x="36" y="21" width="2.5" height="7" rx="1.25" className="band" />
        </>
      );
    case "video":
      return (
        <>
          <rect x="5" y="10" width="38" height="28" rx="5" className="sheet-face" />
          <path className="band" d="m21 17 13 7-13 7Z" />
          {!tiny && <path className="band" d="M5 34h38v4H5Z" />}
        </>
      );
    case "archive":
      return (
        <>
          <path className="sheet-face" d="M8 14h32v25a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4Z" />
          <path className="band" d="M6 9h36v9H6a3 3 0 0 1-3-3v-3a3 3 0 0 1 3-3Z" />
          {!tiny && (
            <>
              <path className="lines" style={{ strokeWidth: 2 }} d="M16 24h16M16 31h16" />
              <rect x="20" y="36" width="8" height="4" rx="2" className="band" />
            </>
          )}
        </>
      );
    case "link":
      return (
        <>
          <rect x="7" y="8" width="34" height="32" rx="7" className="sheet-face" />
          <path className="band" d="M26 13h10v10h-4v-3.2l-9 9-2.8-2.8 9-9H26Z" />
          {!tiny && <path className="lines" d="M17 19h-2a4 4 0 0 0-4 4v8a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4v-2" />}
        </>
      );
    case "generic":
      return <GenericSheet size={size} ext={ext} tucked={tucked} />;
  }
}

function Sheet() {
  return (
    <>
      <path d={SHEET} className="sheet-face" />
      <path d={FOLD} className="fold" />
    </>
  );
}

function GenericSheet({ size, ext, tucked }: { size: number; ext: string; tucked: boolean }) {
  const showBand = ext.length > 0 && ext.length <= 6;
  const showText = showBand && size >= 28;
  const showLines = showBand && size >= 44 && !tucked;
  const labelSize = ext.length <= 3 ? 9.4 : ext.length === 4 ? 8 : 6.6;

  return (
    <>
      <Sheet />
      {showBand && <path d="M9 13.5h30v13H9Z" className="band" />}
      {showText && (
        <text x="24" y="23.3" textAnchor="middle" className="band-text" style={{ fontSize: labelSize }}>
          {ext.toUpperCase()}
        </text>
      )}
      {showLines && <path d="M15 32h18M15 38h12" className="lines" />}
      {!showBand && size >= 44 && !tucked && <path d="M15 22h18M15 29h18M15 36h11" className="lines" />}
    </>
  );
}

function TypeChip({ ext }: { ext: string }) {
  const labelSize = ext.length <= 3 ? 5.8 : ext.length === 4 ? 5.1 : 4.5;
  return (
    <>
      <rect x="27" y="34" width="14" height="8" rx="4" className="band" />
      <text x="34" y="39.7" textAnchor="middle" className="band-text" style={{ fontSize: labelSize }}>
        {ext.toUpperCase()}
      </text>
    </>
  );
}
