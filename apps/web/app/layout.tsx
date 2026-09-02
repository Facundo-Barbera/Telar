import type { Metadata } from "next";
import Script from "next/script";
import { Fira_Code, Geist, Geist_Mono, IBM_Plex_Mono, IBM_Plex_Sans, Inter, JetBrains_Mono } from "next/font/google";
// Streamdown FIRST, so the cockpit's own tokens win where the two overlap.
import "streamdown/styles.css";
import "./globals.css";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/components/theme-provider";
import { AppearanceProvider } from "@/components/appearance-provider";
import { APPEARANCE_INIT_SCRIPT } from "@/lib/appearance";
import { BACKDROP_INIT_SCRIPT } from "@/lib/backdrop";
import { AppShell } from "@/components/app-shell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// The selectable alternatives (Settings → Appearance). Loaded unconditionally:
// next/font self-hosts them at build time and preloads nothing that is not
// used on the page, so the cost of offering them is bytes on disk, not paint.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });
// `preload: false` on the optional faces: they are alternatives, not the
// default, so nothing should pay a preload hint for a face nobody chose.
const plexSans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin"], weight: ["400", "500", "600"], preload: false });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"], preload: false });
const firaCode = Fira_Code({ variable: "--font-fira-code", subsets: ["latin"], preload: false });

export const metadata: Metadata = {
  title: "Telar",
  description: "Engine-owned local project sessions",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    /* `suppressHydrationWarning` because THEME_INIT_SCRIPT mutates this exact
       element's class list before React hydrates — the mismatch is the design,
       not a bug, and it is confined to <html>. */
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} ${jetbrainsMono.variable} ${plexSans.variable} ${plexMono.variable} ${firaCode.variable} h-full antialiased`}>
      <head>
        {/**
         * `next/script`, NOT a bare `<script>`, and the difference is a warning
         * React 19 is right to raise: a `<script>` rendered by a component runs
         * when the SERVER emits it and never again, so on a client navigation
         * it is inert markup that looks like code. It happened to work here —
         * this only ever needs to run on the server's first HTML — but "happens
         * to work for a reason nobody wrote down" is how the next person breaks
         * it by moving it.
         *
         * `beforeInteractive` keeps the one property that matters: injected
         * into the initial HTML, executed before any Next.js module and before
         * hydration, which is what stops the wrong theme painting for a frame.
         * The `id` is required for an inline script — Next tracks it by id.
         */}
        <Script id="telar-theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Accent, typefaces and translucency, applied the same pre-paint way
            and for the same reason — see lib/appearance.ts. */}
        <Script id="telar-appearance-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }} />
        {/* The scene under the app — gradient or image — painted the same
            pre-paint way onto the #app-backdrop div below. */}
        <Script id="telar-backdrop-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: BACKDROP_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full">
        {/* The backdrop layer (lib/backdrop.ts): display:none until <html>
            wears data-backdrop, then painted entirely from CSS variables. */}
        <div id="app-backdrop" aria-hidden="true" />
        <ThemeProvider>
          <AppearanceProvider>
            <AppShell>{children}</AppShell>
          </AppearanceProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
