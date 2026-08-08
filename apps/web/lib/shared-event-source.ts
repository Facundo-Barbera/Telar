// ONE SOCKET PER URL, HOWEVER MANY SUBSCRIBERS (issue #82).
//
// The measured failure: a working session sat at the browser's HTTP/1.1
// per-origin cap (6 connections) and every navigation's RSC fetch queued
// behind SSE streams that would not yield — the app read as frozen. Among
// the holders was a GUARANTEED duplicate: a session that both IS a loom
// (use-loom-handoff) and WATCHES that same loom (use-watcher-alerts)
// opened two independent EventSources to the identical
// /api/looms/[id]/events URL — two sockets, one stream of facts.
//
// This registry makes the socket a shared resource: acquire returns the
// URL's one EventSource (creating it on first acquire), release decrements,
// and the socket closes when the last subscriber leaves. Subscribers attach
// and remove their own listeners; they NEVER call close() on the shared
// source — the one rule of the API, because one consumer's teardown must not
// sever another's stream.
//
// THE TERMINAL "end" IS THE REGISTRY'S TO HANDLE, for the same reason: the
// loom events route sends `end` then closes, and without a central close
// EventSource would auto-reconnect forever against a finished loom (the
// churn use-watcher-alerts' own comment warned about). The registry
// closes and evicts on `end`; a later acquire of the same URL gets a fresh
// socket, which is correct — "the loom ended" is a fact about that stream,
// not about the URL for all time.
//
// Module-level state, not globalThis: this is client-bundle code and a dev
// HMR reload re-creating sockets is acceptable (they are cheap to reopen);
// the invariant that matters — never two live sockets for one URL within a
// running page — holds per module instance.

type Entry = { source: EventSource; refs: number };

const entries = new Map<string, Entry>();

/** Injectable for tests only — bun's test runtime has no EventSource. */
type SourceFactory = (url: string) => EventSource;
let createSource: SourceFactory = (url) => new EventSource(url);

export function _setEventSourceFactoryForTests(factory: SourceFactory | null): void {
  createSource = factory ?? ((url) => new EventSource(url));
  entries.clear();
}

export function acquireSharedEventSource(url: string): {
  source: EventSource;
  release: () => void;
} {
  let entry = entries.get(url);
  if (!entry || entry.source.readyState === 2 /* CLOSED */) {
    const source = createSource(url);
    source.addEventListener("end", () => {
      source.close();
      if (entries.get(url)?.source === source) entries.delete(url);
    });
    entry = { source, refs: 0 };
    entries.set(url, entry);
  }
  entry.refs++;
  const held = entry;
  let released = false;
  return {
    source: held.source,
    release: () => {
      // Idempotent: React strict-mode double-invokes cleanups, and a cleanup
      // that decrements twice would close a socket a sibling still holds.
      if (released) return;
      released = true;
      held.refs--;
      if (held.refs <= 0) {
        held.source.close();
        if (entries.get(url)?.source === held.source) entries.delete(url);
      }
    },
  };
}
