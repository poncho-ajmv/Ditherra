"use client";

// Pixel-art icons. Most are from Pixelarticons (MIT, github.com/halfmage/pixelarticons)
// — 24×24 filled paths. A few the set doesn't have (eraser, fill bucket, line,
// a full rectangle) are drawn in the same pixel grid so the set stays coherent.
const ICONS: Record<string, string> = {
  // Pixelarticons
  pencil: "M4 16H6V18H8V20H10V22H2V14H4V16ZM12 20H10V18H12V20ZM14 18H12V16H14V18ZM10 16H8V14H10V16ZM16 16H14V14H16V16ZM6 14H4V12H6V14ZM12 14H10V12H12V14ZM18 14H16V12H18V14ZM8 12H6V10H8V12ZM14 12H12V10H14V12ZM20 12H18V10H20V12ZM10 10H8V8H10V10ZM18 10H16V8H18V10ZM22 10H20V8H22V10ZM12 8H10V6H12V8ZM16 8H14V6H16V8ZM20 8H18V6H20V8ZM14 6H12V4H14V6ZM18 6H16V4H18V6ZM16 4H14V2H16V4Z",
  eyedropper: "M3 15h2v4H3zm2 4h4v2H5zm0-6h2v2H5zm4 4h2v2H9zm-2-6h2v2H7zm4 4h2v2h-2zM9 9h2v2H9zm4 4h2v2h-2zm-2-6h2v2h-2zM9 5h2v2H9zm2-2h2v2h-2zm2 2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2zm-4-4h2v2h-2zm2 2h2v2h-2zM1 19h2v4H1z",
  hand: "M21 7h2v5h-2zm-4-2h2v7h-2zm-4-2h2v8h-2zM9 3h2v8H9zM5 5h2v8H5zm14 0h2v2h-2zm-4-2h2v2h-2zm-4-2h2v2h-2zM7 3h2v2H7zm-4 8h2v2H3zm-2 2h2v2H1zm0 2h2v2H1zm2 2h2v2H3zm2 2h2v2H5zm2 2h12v2H7zm12-2h2v2h-2zm2-7h2v7h-2zM5 13h2v2H5zm2 2h2v2H7z",
  select: "M12 10h2v12h-2zm2 0h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zm-6 4h2v2h-2zm2-2h6v2h-6zM2 16h2v4H2zm2 4h2v2H4zm4 0h2v2H8zM2 10h2v4H2zm0-6h2v4H2zm2-2h2v2H4zm4 0h4v2H8zm6 0h4v2h-4zm6 2h2v4h-2zm0 6h2v2h-2z",
  circle: "M6 2h12v2H6zm0 18h12v2H6zM2 6h2v12H2zm18 0h2v12h-2zm-2-2h2v2h-2zm0 14h2v2h-2zM4 4h2v2H4zm0 14h2v2H4z",
  undo: "M18 20h-6v-2h6v2Zm2-2h-2v-8h2v8Zm-10-4H8v-2H6v-2H4V8h2V6h2V4h2v4h8v2h-8v4Z",
  redo: "M20 8H6v2h14zM4 10h2v8H4zm2 8h6v2H6z",
  zoomIn: "M22 22h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-6-2H6v-2h8v2Zm4 0h-2v-2h2v2ZM6 16H4v-2h2v2Zm10 0h-2v-2h2v2ZM4 14H2V6h2v8Zm7-5h3v2h-3v3H9v-3H6V9h3V6h2v3Zm7 5h-2V6h2v8ZM6 6H4V4h2v2Zm10 0h-2V4h2v2Zm-2-2H6V2h8v2Z",
  zoomOut: "M22 22h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-6-2H6v-2h8v2Zm4 0h-2v-2h2v2ZM6 16H4v-2h2v2Zm10 0h-2v-2h2v2ZM4 14H2V6h2v8Zm14 0h-2V6h2v8Zm-4-5v2H6V9h8ZM6 6H4V4h2v2Zm10 0h-2V4h2v2Zm-2-2H6V2h8v2Z",
  trash: "M6 7h2v2H6zm14 0h2v10h-2zM8 5h12v2H8zM4 9h2v2H4zm-2 2h2v2H2zm2 2h2v2H4zm2 2h2v2H6zm2 2h12v2H8zm6-6h2v2h-2zm2 2h2v2h-2zm0-4h2v2h-2zm-4 4h2v2h-2zm0-4h2v2h-2z",
  download: "M21 15v4h-2v-4zm-2 4v2H5v-2zM5 15v4H3v-4zm8-12v14h-2V3z",
  upload: "M11 3h2v2h-2zM9 5h2v2H9zm4 0h2v2h-2zM7 7h2v2H7zm8 0h2v2h-2zm-4 0h2v8h-2zM3 15h2v4H3zm16 0h2v4h-2zM5 19h14v2H5z",
  send: "M4 19h4v2H2v-8h2v6Zm8 0H8v-2h4v2Zm4-2h-4v-2h4v2Zm4-2h-4v-2h4v2Zm-10-2H4v-2h6v2Zm12 0h-2v-2h2v2ZM8 5H4v6H2V3h6v2Zm12 6h-4V9h4v2Zm-4-2h-4V7h4v2Zm-4-2H8V5h4v2Z",
  // Pixelarticons — general UI
  plus: "M13 11h7v2h-7v7h-2v-7H4v-2h7V4h2v7Z",
  minus: "M4 11h16v2H4z",
  close: "M7 19H5V17H7V19ZM19 19H17V17H19V19ZM9 15V17H7V15H9ZM17 17H15V15H17V17ZM11 15H9V13H11V15ZM15 15H13V13H15V15ZM13 13H11V11H13V13ZM11 11H9V9H11V11ZM15 11H13V9H15V11ZM9 9H7V7H9V9ZM17 9H15V7H17V9ZM7 7H5V5H7V7ZM19 7H17V5H19V7Z",
  check: "M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z",
  chevronDown: "M13 16h-2v-2h2v2Zm-2-2H9v-2h2v2Zm4 0h-2v-2h2v2Zm-6-2H7v-2h2v2Zm8 0h-2v-2h2v2ZM7 10H5V8h2v2Zm12 0h-2V8h2v2Z",
  chevronRight: "M16 13v-2h-2v2h2Zm-2-2V9h-2v2h2Zm0 4v-2h-2v2h2Zm-2-6V7h-2v2h2Zm0 8v-2h-2v2h2ZM10 7V5H8v2h2Zm0 12v-2H8v2h2Z",
  imageNew: "M8 6h8v2H8zM6 8h2v8H6zm2 8h8v2H8zm8-8h2v8h-2zm-4 4h2v2h-2zm2-2h2v2h-2zm-4 4h2v2h-2zm1-13h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zm-1-8h2v2h-2zM3 3h2v2H3zM1 1h2v2H1zm2 18h2v2H3zm-2 2h2v2H1zm18-2h2v2h-2zm2 2h2v2h-2zm0-20h2v2h-2zM9 9h2v2H9z",
  arrowRight: "M4 11v2h16v-2zm12 2v2h2v-2zm-2 2v2h2v-2zm-2 2v2h2v-2zm4-6V9h2v2z",
  // Drawn in the same pixel grid where Pixelarticons has no match
  // A 50% checker — the pattern the tool actually paints.
  dither: "M4 4h4v4H4zm8 0h4v4h-4zM8 8h4v4H8zm8 0h4v4h-4zM4 12h4v4H4zm8 0h4v4h-4zM8 16h4v4H8zm8 0h4v4h-4z",
  // A ring around a solid core: silhouette plus its outline.
  outline: "M8 4h8v2H8zM6 6h2v2H6zm10 0h2v2h-2zM4 8h2v8H4zm14 0h2v8h-2zM6 16h2v2H6zm10 0h2v2h-2zM8 18h8v2H8zM9 9h6v6H9z",
  // Two halves facing each other across an axis.
  mirror: "M11 3h2v18h-2zM3 7h6v2H3zm0 4h6v2H3zm0 4h6v2H3zM15 7h6v2h-6zm0 4h6v2h-6zm0 4h6v2h-6z",
  eraser: "M10 10h8v2h-8zM8 12h8v2H8zM6 14h8v2H6zM4 16h8v2H4zm10-8h2v2h-2zm2 2h2v2h-2zm-2 2h2v2h-2z",
  bucket: "M6 8h12v2H6zM7 10h10v2H7zM8 12h8v2H8zM9 14h6v2H9zM10 16h4v2h-4zm8-12h2v2h-2zm-2 2h2v2h-2zm2 2h2v2h-2z",
  line: "M2 18h2v2H2zm2-2h2v2H4zm2-2h2v2H6zm2-2h2v2H8zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2zm2-2h2v2h-2z",
  rect: "M4 4h16v2H4zM4 16h16v2H4zM4 6h2v10H4zm14 0h2v10h-2z",
  settings: "M4 6h16v2H4zm4-2h2v6H8zM4 12h16v2H4zm10-2h2v6h-2zM4 18h16v2H4zm4-2h2v6H8z",
  stop: "M6 6h12v12H6z",
};

export function PixelIcon({ name, size = 16 }: { name: string; size?: number }) {
  const d = ICONS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ display: "block" }}>
      <path d={d} />
    </svg>
  );
}
