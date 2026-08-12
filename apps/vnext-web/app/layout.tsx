import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
// Streamdown FIRST, so the cockpit's own tokens win where the two overlap.
import "streamdown/styles.css";
import "./globals.css";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/components/theme-provider";
import { VNextAppShell } from "@/components/vnext-app-shell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Telar",
  description: "Engine-owned local project sessions",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    /* `suppressHydrationWarning` because THEME_INIT_SCRIPT mutates this exact
       element's class list before React hydrates — the mismatch is the design,
       not a bug, and it is confined to <html>. */
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <ThemeProvider>
          <VNextAppShell>{children}</VNextAppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
