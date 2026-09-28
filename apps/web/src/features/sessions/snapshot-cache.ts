"use client";

import type { SessionSnapshot } from "@telar/engine-client";

type CachedSession = SessionSnapshot & { savedAt: number };

export interface SnapshotStore {
  read(key: string): Promise<CachedSession | undefined>;
  write(key: string, value: CachedSession): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export function snapshotKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

export const LOCAL_HOST = "local";

export const SESSIONS_PER_HOST = 30;

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

function browserSnapshotStore(): SnapshotStore | undefined {
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
export function snapshotStore(): SnapshotStore | undefined {
  if (shared === null) shared = browserSnapshotStore();
  return shared;
}
