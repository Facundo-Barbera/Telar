"use client";

// KEEPS THE TRANSCRIPT RENDERER OUT OF EVERY ROUTE'S GRAPH.
//
// `<Dock>` is rendered from the root layout, so its imports are part of the
// module graph of EVERY page. It pulls `MessageResponse` (dock.tsx:27) for the
// compact markdown in a docked head, and that reaches streamdown and the whole
// conversation renderer. Meanwhile dock.tsx:435 is
//     if (!mounted || entries.length === 0) return null;
// — so in the overwhelmingly common case (nothing docked) all of that was
// compiled, shipped and hydrated in order to render nothing at all.
//
// WHY THIS MATTERS MORE IN DEV THAN IN PRODUCTION. `next dev` compiles routes
// on demand, but the root layout is part of every one of them, so a fat layout
// graph is re-paid at every first-visit compile — and none of production's
// minification or long-term chunk caching is there to hide it. A packaged build
// feels fine while the dev server does not, which is exactly the asymmetry we
// were chasing.
//
// The gate is `entries.length` rather than a plain `dynamic()` because a bare
// dynamic import would still fetch the chunk on mount. Nothing is requested
// until a session is actually docked. Behaviour is unchanged: dock.tsx already
// returned null in this state, and `SessionRuntimeHost` is rendered per entry
// *after* that early return, so no host is lost by not mounting.
//
// `ssr: false` costs nothing here for the same reason — dock.tsx guards on a
// `mounted` flag and renders null on the server pass regardless.

import dynamic from "next/dynamic";
import { useDock } from "./dock-provider";

const Dock = dynamic(() => import("./dock").then((m) => m.Dock), { ssr: false });

export function DockMount() {
  const { entries } = useDock();
  if (entries.length === 0) return null;
  return <Dock />;
}
