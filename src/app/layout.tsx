import "./globals.css";

export const metadata = { title: "OpenMarkup", description: "Pin comments on a live website and export them as Markdown.", robots: { index: false, follow: false } };

// Before first paint: follow the system's light or dark setting, and keep following it.
const themeScript = `(function(){var m=matchMedia("(prefers-color-scheme: dark)");function s(){document.documentElement.classList.toggle("dark",m.matches)}s();m.addEventListener("change",s)})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Fira+Code:wght@400;500&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
