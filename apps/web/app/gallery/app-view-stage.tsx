"use client";

import { useEffect } from "react";
import type { GalleryAppEntry } from "@/lib/gallery-fixtures";
import { setActiveScene } from "@/lib/gallery-fixtures";
import DashboardPage from "@/app/page";
import ProjectsPage from "@/app/projects/page";
import ProjectDetailPage from "@/app/projects/[name]/page";
import LoomsPage from "@/app/looms/page";
import { ProjectSettings } from "@/components/projects/settings-view";

// The full-page seam: full app pages are already "use client" default exports
// that self-fetch their own collection endpoints (/api/looms, /api/projects,
// /api/chats, /api/usage, /api/accounts, …). Those endpoints carry no id, so the
// URL-keyed loom interceptor can't answer them — instead we publish the entry's
// GalleryScene into the active-scene ref that resolveGalleryAppFetch consults.
//
// EXACTNESS: this renders the REAL default-export page component (no fork). The
// page's own module-private inline sub-components (SectionHeading / ProjectMiniCard /
// SessionRow / LoomRow / ManifestCard …) render exactly as production does; only
// the fetch answers are fixtures. Pages mirrored:
//   dashboard        -> app/page.tsx (DashboardPage)
//   projects         -> app/projects/page.tsx (ProjectsPage)
//   project-detail   -> app/projects/[name]/page.tsx (ProjectDetailPage)
//   project-settings -> components/projects/settings-view.tsx (ProjectSettings)
//   looms            -> app/looms/page.tsx (LoomsPage, wraps LoomsInner in Suspense)
//
// ORDERING: the scene is set SYNCHRONOUSLY at the top of render (module code runs
// before children mount), so it is already live when a child's fetch-on-mount
// effect fires. The cleanup effect clears it on unmount — same discipline as the
// interceptor being the layout's first child.
export function AppViewStage({ entry }: { entry: GalleryAppEntry }) {
  // Synchronous publish — the render phase runs before ANY commit-phase effect or
  // cleanup, so setting the scene here establishes it for every child's
  // fetch-on-mount effect. Deliberately NOT cleared on unmount: on a client-side
  // navigation the NEXT stage's render (this line) runs before the OLD stage's
  // cleanup would; nulling on unmount would clobber the incoming scene AFTER the
  // new page's child fetch effect already read it. Every stage instead sets its
  // own scene-or-null at render (the loom stage sets null), so the last render
  // always wins. Leaving the gallery uninstalls the interceptor (layout unmount),
  // so a lingering ref is inert.
  setActiveScene(entry.scene);
  useEffect(() => {
    setActiveScene(entry.scene); // re-assert under StrictMode's double-invoke
  }, [entry.scene]);

  switch (entry.view) {
    case "dashboard":
      return <DashboardPage />;
    case "projects":
      return <ProjectsPage />;
    case "project-detail":
      // ProjectDetailPage reads params via React.use() — feed a resolved promise.
      return (
        <ProjectDetailPage
          params={Promise.resolve({ name: entry.params?.name ?? "" })}
        />
      );
    case "project-settings":
      return <ProjectSettings name={entry.params?.name ?? ""} />;
    case "looms":
      // Default export wraps LoomsInner in Suspense for useSearchParams. Do NOT
      // pass ?new=1 (looms/page.tsx:58 auto-redirects to the planner) — the
      // gallery route carries no query, so LoomsPage stays on the index.
      return <LoomsPage />;
    default:
      return null;
  }
}
