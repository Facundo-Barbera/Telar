/**
 * WHICH MAC A WINDOW IS TALKING TO — decided from the address bar.
 *
 * Every screen in this cockpit calls `createEngineApi()` at module level and
 * asks it for `/api/…`. Twenty-eight of them. Threading a host through each
 * would touch every one and every prop between; reading it from the pathname
 * touches none, and it is the same answer the sidebar already derives for
 * "which session is open" (`activeSessionFromPathname`). A remote Mac's
 * screens live under `/hosts/:id/…`, so a request made from one of them is
 * rewritten to `/api/hosts/:id/…` — the proxy that carries that Mac's token.
 *
 * `LOCAL_HOST_ID` is the absence of the hop: a pathname with no host prefix,
 * or the local id itself, sends `/api/…` unchanged.
 */

import { LOCAL_HOST_ID } from "./book";

export { LOCAL_HOST_ID };

/** `/hosts/:id/…` → the id; anything else → local. */
export function hostFromPathname(pathname: string): string {
  const match = /^\/hosts\/([^/?#]+)/.exec(pathname);
  if (!match) return LOCAL_HOST_ID;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1]!;
  }
}

/** The prefix a remote host's screens live under; empty for local. */
export function hostPrefix(hostId: string | undefined): string {
  return !hostId || hostId === LOCAL_HOST_ID ? "" : `/hosts/${encodeURIComponent(hostId)}`;
}

/** `/api/x` on a remote host → `/api/hosts/:id/x`. Anything that is not an
 *  `/api/` path — a full URL, a static asset — is left alone. */
export function rewriteApiPath(pathname: string, hostId: string): string {
  if (hostId === LOCAL_HOST_ID || !pathname.startsWith("/api/")) return pathname;
  // The hosts routes themselves are always local: a remote's own list of
  // remotes is not this cockpit's business, and a nested hop would loop.
  if (pathname.startsWith("/api/hosts/") || pathname === "/api/hosts") return pathname;
  return `/api/hosts/${encodeURIComponent(hostId)}${pathname.slice("/api".length)}`;
}

type Fetcher = typeof fetch;

/** A fetcher pinned to one host — for a screen that knows which Mac it is
 *  about regardless of the address bar (the sidebar, fanning out). */
export function hostFetcher(hostId: string, base: Fetcher = fetch): Fetcher {
  if (hostId === LOCAL_HOST_ID) return base;
  return (input, init) => {
    if (typeof input === "string") return base(rewriteApiPath(input, hostId), init);
    if (input instanceof URL) return base(input, init);
    return base(input, init);
  };
}

/**
 * The DEFAULT fetcher: the host is whatever the current pathname says. Read
 * at call time, not at module load, so a singleton created on a local screen
 * still reaches the right Mac after a client-side navigation to a remote one.
 * On the server there is no pathname and no proxy hop — plain fetch.
 */
export const pathnameFetcher: Fetcher = (input, init) => {
  if (typeof window === "undefined" || typeof input !== "string") return fetch(input, init);
  return fetch(rewriteApiPath(input, hostFromPathname(window.location.pathname)), init);
};
