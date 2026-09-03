"use client";

/**
 * THE LAST THING RECORDED, kept in the browser.
 *
 * When the engine goes away — the desktop app quits, a remote Mac drops off
 * the tailnet — the cockpit's transcript went with it: an error card where
 * the conversation had been a second earlier. t3 keeps a per-environment
 * thread snapshot in IndexedDB and renders it while the real read is in
 * flight; this is that.
 *
 * NOT THE REGISTRY. lib/projects.ts is right that engine state belongs to
 * the engine and a per-browser copy would show two clients two different
 * registries. A snapshot is a different thing: it is explicitly a PHOTOGRAPH
 * with a timestamp on it, shown only while the engine cannot be asked, and
 * replaced the moment it can. The banner says so.
 *
 * INDEXEDDB, RAW. A session snapshot is hundreds of kilobytes of items and
 * events; localStorage's few megabytes and synchronous writes are the wrong
 * shape for it. The wrapper below is the four calls this needs and nothing
 * more, behind an interface an in-memory implementation can satisfy for
 * tests — bun has no IndexedDB.
 */

import type { SessionSnapshot } from "@telar/engine-client";

export type CachedSession = SessionSnapshot & { savedAt: number };

export interface SnapshotStore {
  read(key: string): Promise<CachedSession | undefined>;
  write(key: string, value: CachedSession): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every key with this prefix — for pruning one host's entries. */
  keys(prefix: string): Promise<string[]>;
}

/** Two Macs can mint the same session id; the host rides in front. */
export function snapshotKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

/**
 * The Mac with no hop — the engine this cockpit runs beside. The same id
 * `lib/hosts/book.ts` spells as LOCAL_HOST_ID; kept here as the caches' own
 * fallback so a caller with no host in hand still writes under one key.
 */
export const LOCAL_HOST = "local";

/** Newest-first eviction bound per host — tidiness, not space. */
export const SESSIONS_PER_HOST = 30;

/**
 * Save, then keep only the newest N for this host. Pure over the store so
 * the eviction rule is a unit test.
 */
export async function saveSnapshot(store: SnapshotStore, hostId: string, sessionId: string, snapshot: SessionSnapshot, now = Date.now()): Promise<void> {
  await store.write(snapshotKey(hostId, sessionId), { ...snapshot, savedAt: now });
  const keys = await store.keys(`${hostId}:`);
  if (keys.length <= SESSIONS_PER_HOST) return;
  const dated = await Promise.all(keys.map(async (key) => ({ key, savedAt: (await store.read(key))?.savedAt ?? 0 })));
  dated.sort((left, right) => right.savedAt - left.savedAt);
  await Promise.all(dated.slice(SESSIONS_PER_HOST).map((entry) => store.remove(entry.key)));
}

export function memorySnapshotStore(): SnapshotStore {
  const map = new Map<string, CachedSession>();
  return {
    async read(key) {
      return map.get(key);
    },
    async write(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
    async keys(prefix) {
      return [...map.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

const DB_NAME = "telar-snapshots";
const STORE = "sessions";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

/** The browser's store. Absent (undefined) where IndexedDB is — private
 *  mode in some browsers, the server — so a caller can simply not cache. */
export function browserSnapshotStore(): SnapshotStore | undefined {
  if (typeof indexedDB === "undefined") return undefined;
  return {
    read: (key) => run<CachedSession | undefined>("readonly", (store) => store.get(key) as IDBRequest<CachedSession | undefined>),
    write: (key, value) => run("readwrite", (store) => store.put(value, key)).then(() => undefined),
    remove: (key) => run("readwrite", (store) => store.delete(key)).then(() => undefined),
    keys: (prefix) =>
      run<IDBValidKey[]>("readonly", (store) => store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`))).then((keys) =>
        keys.map(String),
      ),
  };
}

let shared: SnapshotStore | undefined | null = null;
/** One store per window, resolved lazily so importing this on the server is free. */
export function snapshotStore(): SnapshotStore | undefined {
  if (shared === null) shared = browserSnapshotStore();
  return shared;
}
