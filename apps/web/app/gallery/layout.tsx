import type { ReactNode } from "react";
import type { Metadata } from "next";
import { GalleryFetchInterceptor } from "./gallery-fetch-interceptor";
import { GalleryNav } from "./gallery-nav";

export const metadata: Metadata = {
  title: "DEV Gallery — Telar",
  robots: { index: false, follow: false },
};

export default function GalleryLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col">
      {/* FIRST child on purpose: React flushes passive effects depth-first, first
          sibling first, so the interceptor installs the fetch wrapper before any
          stage component's fetch-on-mount effect (e.g. WorkstreamsPreview) fires. */}
      <GalleryFetchInterceptor />

      {/* Requirement (3): a persistent banner on every gallery page. */}
      <div className="flex shrink-0 items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-black">
        <span aria-hidden>⚠</span>
        DEV GALLERY — FAKE DATA
        <span aria-hidden>⚠</span>
      </div>

      <div className="flex min-h-0 flex-1">
        <GalleryNav />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
