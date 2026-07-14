import type { ReactNode } from "react";
import type { Metadata } from "next";
// Reuse the /gallery fetch seam so demo redesigns that mirror app views hit
// fixture data, never a real backend/registry. Read-only import.
import { GalleryFetchInterceptor } from "../gallery/gallery-fetch-interceptor";
import { DemoNav } from "./demo-nav";

export const metadata: Metadata = {
  title: "DEMO Gallery — Telar",
  robots: { index: false, follow: false },
};

// Full-screen own shell (h-dvh flex-col) — the redesigns render in their own
// chrome, not the live AppSidebar. This route is TEMPORARY: it is a one-off
// design-review surface and gets deleted after the pass, like /gallery.
export default function DemoGalleryLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col">
      {/* FIRST child on purpose: the fetch wrapper must install before any
          stage's fetch-on-mount effect fires (React flushes passive effects
          depth-first, first sibling first). */}
      <GalleryFetchInterceptor />

      <div className="flex shrink-0 items-center justify-center gap-2 bg-amber-500 px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-black">
        <span aria-hidden>⚠</span>
        DEMO GALLERY — REDESIGN CANDIDATES · FAKE DATA · TEMPORARY (deleted after design pass)
        <span aria-hidden>⚠</span>
      </div>

      <div className="flex min-h-0 flex-1">
        <DemoNav />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
