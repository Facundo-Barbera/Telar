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

/**
 * THE NAME A PAIRED MAC ANSWERS UNDER, stamped by this cockpit's own proxy on
 * everything it carries back (lib/hosts/proxy.ts).
 *
 * It is read off the reads a screen was making anyway, so an error can say
 * WHICH MAC refused without a request of its own — and it is the proxy's word,
 * not the remote's: the hop overwrites any header of this name the other end
 * sent, so a remote cannot name itself something else here.
 */
export const HOST_NAME_HEADER = "telar-host";

/** hostId → what that Mac called itself, as of its last answer. Module-level
 *  because it is a property of the pairing, not of any one screen, and every
 *  screen that hops learns it for all the others. */
const observedNames = new Map<string, string>();

/** What a paired Mac calls itself, or nothing — for local, and for a Mac this
 *  window has not reached yet. Never invents a name from an id. */
export function hostName(hostId: string | undefined): string | undefined {
  if (!hostId || hostId === LOCAL_HOST_ID) return undefined;
  return observedNames.get(hostId);
}

/** Exported for the tests, and for a caller that already holds the book. */
export function rememberHostName(hostId: string, name: string): void {
  const trimmed = name.trim();
  if (hostId === LOCAL_HOST_ID || !trimmed) return;
  observedNames.set(hostId, trimmed);
}

/** A fetcher that says which Mac it reaches. The pin travels ON the fetcher so
 *  `createEngineApi` can attribute a failure without every one of its ~150
 *  methods taking a host argument. */
export type PinnedFetcher = Fetcher & { readonly telarHostId: string };

/** Which Mac a fetcher is pinned to, or nothing when it follows the address
 *  bar (`pathnameFetcher`) and so cannot say in advance. */
export function pinnedHost(fetcher: Fetcher): string | undefined {
  return (fetcher as Partial<PinnedFetcher>).telarHostId;
}

/** A fetcher pinned to one host — for a screen that knows which Mac it is
 *  about regardless of the address bar (the sidebar, fanning out). */
export function hostFetcher(hostId: string, base: Fetcher = fetch): PinnedFetcher {
  // WRAPPED EVEN WHEN IT IS A NO-OP: this used to hand `base` back for local,
  // and stamping the pin onto that value would write a property onto the global
  // `fetch`. One closure is cheaper than a mutated global.
  if (hostId === LOCAL_HOST_ID) {
    const local: Fetcher = (input, init) => base(input, init);
    return Object.assign(local, { telarHostId: LOCAL_HOST_ID });
  }
  const remote: Fetcher = async (input, init) => {
    const response = typeof input === "string" ? await base(rewriteApiPath(input, hostId), init) : await base(input, init);
    const name = response.headers.get(HOST_NAME_HEADER);
    if (name) rememberHostName(hostId, name);
    return response;
  };
  return Object.assign(remote, { telarHostId: hostId });
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
