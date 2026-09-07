import type { Metadata } from "next";
import { Pixelify_Sans } from "next/font/google";
import "./globals.css";

// Pixelify Sans everywhere — a pixel-art typeface for a pixel-art tool. Both
// roles (sans and mono) map to it via the CSS variables in globals.css.
const pixelify = Pixelify_Sans({
  variable: "--font-pixelify",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Ditherra",
  description: "Free pixel art studio",
};

// Runs before the first paint, so the saved theme is applied instead of flashing
// the default and then correcting. Deliberately tiny and dependency-free.
const applyPreferences = `
try {
  var t = localStorage.getItem('ditherra.theme');
  if (t) document.documentElement.dataset.theme = t;
  var l = localStorage.getItem('ditherra.lang');
  if (l) document.documentElement.lang = l;
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={pixelify.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: applyPreferences }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
