import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
// Streamdown FIRST, so the cockpit's own tokens win where the two overlap.
import "streamdown/styles.css";
import "./globals.css";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/components/theme-provider";
import { AppShell } from "@/components/app-shell";

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
      </head>
      <body className="min-h-full">
        <ThemeProvider>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
