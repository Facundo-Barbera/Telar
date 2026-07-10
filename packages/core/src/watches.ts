// Loom watch registry: ~/.telar/watches.json (docs/watchers-design.md §4).
// A session registers a watch on a loom; the reactor fires when the loom hits a
// trigger state. This is the persisted store only — add/list/cancel — mirroring
// the atomic-write + telarDir pattern in manifest.ts and the JSON shape in
// secrets.ts. A missing/corrupt file reads as empty.
import fs from "node:fs";
import path from "node:path";
import { telarDir } from "./manifest";
import type { WorkUnitState } from "./schemas";

export type Watch = {
  id: string; // watch_<base36>
  loomId: string; // the watched loom
  sessionId: string; // the owning session (chat id)
  triggerStates: WorkUnitState[];
  createdAt: number;
  status: "active" | "fired" | "cancelled";
  lastFiredState?: WorkUnitState; // de-dupe: don't re-fire on the same state
};

// Owner-actionable states — the states that need the owner (docs §1).
export const DEFAULT_TRIGGER_STATES: WorkUnitState[] = [
  "needs-review",
  "blocked",
  "failed",
  "done",
  "ready",
];

type WatchFile = { watches: Watch[] };
const watchesFile = () => path.join(telarDir(), "watches.json");

function read(): WatchFile {
  try {
    const data = JSON.parse(fs.readFileSync(watchesFile(), "utf8"));
    return { watches: Array.isArray(data.watches) ? data.watches : [] };
  } catch {
    return { watches: [] };
  }
}

function write(data: WatchFile) {
  const file = watchesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function addWatch(input: {
  loomId: string;
  sessionId: string;
  triggerStates?: WorkUnitState[];
}): Watch {
  const data = read();
  // Replace any existing ACTIVE watch for the same (sessionId, loomId) rather
  // than duplicating; cancelled/fired records are kept and don't block a new one.
  data.watches = data.watches.filter(
    (w) =>
      !(w.status === "active" && w.sessionId === input.sessionId && w.loomId === input.loomId),
  );
  const now = Date.now();
  const watch: Watch = {
    id: `watch_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    loomId: input.loomId,
    sessionId: input.sessionId,
    triggerStates: input.triggerStates ?? [...DEFAULT_TRIGGER_STATES],
    createdAt: now,
    status: "active",
  };
  data.watches.push(watch);
  write(data);
  return watch;
}

export function listWatches(sessionId?: string): Watch[] {
  return read().watches.filter(
    (w) => w.status === "active" && (sessionId === undefined || w.sessionId === sessionId),
  );
}

export function cancelWatch(id: string): boolean {
  const data = read();
  const watch = data.watches.find((w) => w.id === id);
  if (!watch) return false;
  watch.status = "cancelled";
  write(data);
  return true;
}
