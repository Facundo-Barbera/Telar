import fs from "node:fs";
import path from "node:path";
import { EngineEvent } from "@telar/engine-client";
import { atomicWrite } from "../fs/atomic";
import { statePaths } from "../fs/state-paths";
import type { ExecutionHousekeeping, ExecutionStore } from "./execution-store";

const FILES = ["session.json", "queue.json", "items.json", "requests.json", "tasks.json"];

/** A previous binary must fail closed instead of reading stale JSON state. */
export function fenceLegacy(root: string, sessionId: string): void {
  const file = path.join(root, "sessions", sessionId, "session.json");
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes('"backend": "sqlite"')) return;
  atomicWrite(file, { version: -1, backend: "sqlite", message: "This history requires a SQLite-capable Telar build." });
}

function importJournal(store: ExecutionStore, sessionId: string, raw: string): void {
  const lines = raw.split("\n");
  // Only a torn final append may be ignored; corrupt committed rows fail import.
  if (!raw.endsWith("\n") && lines.at(-1)) {
    try { JSON.parse(lines.at(-1)!); } catch { lines.pop(); }
  }
  let previous = 0;
  for (const line of lines) if (line) {
    const event = EngineEvent.parse(JSON.parse(line));
    if (event.sessionId !== sessionId || !Number.isSafeInteger(event.id) || event.id <= previous)
      throw new Error(`Invalid journal sequence in ${sessionId}`);
    store.append(event); previous = event.id;
  }
}

/** Imports a pre-SQLite home once, copying every file it reads into `execution-json-backup` first. */
export function importLegacy(store: ExecutionStore): void {
  const backup = path.join(store.root, "execution-json-backup");
  store.transaction("import", () => {
    for (const entry of fs.readdirSync(path.join(store.root, "sessions"), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(entry.name)) continue;
      for (const name of [...FILES, "events.ndjson"]) {
        const file = path.join(store.root, "sessions", entry.name, name);
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, "utf8");
        const saved = path.join(backup, entry.name, name);
        fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 });
        if (!fs.existsSync(saved)) fs.copyFileSync(file, saved, fs.constants.COPYFILE_EXCL);
        if (name === "events.ndjson") importJournal(store, entry.name, raw);
        else store.statement("INSERT INTO documents(key,value) VALUES(?,?)").run(`sessions/${entry.name}/${name}`, JSON.stringify(JSON.parse(raw)));
      }
    }
    for (const file of [statePaths(store.root).taskStops, statePaths(store.root).subscriptions]) {
      if (!fs.existsSync(file)) continue;
      fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
      const copy = path.join(backup, path.basename(file));
      if (!fs.existsSync(copy)) fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
      store.write(file, JSON.parse(fs.readFileSync(file, "utf8")));
    }
    store.db.prepare("INSERT INTO metadata(key,value) VALUES('imported','1')").run();
    store.db.prepare("INSERT INTO metadata(key,value) VALUES('imported-at',?)").run(String(store.now()));
  });
}

export function exportLegacy(store: ExecutionStore, destination: string): void {
  if (fs.existsSync(destination)) throw new Error("Export destination must not already exist");
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const row of store.db.prepare("SELECT key,value FROM documents ORDER BY key").all()) {
    // Offset indexes describe this store's compact text, not the exported bytes.
    if (String(row.key).endsWith(".index.json")) continue;
    const file = path.join(destination, String(row.key));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWrite(file, JSON.parse(String(row.value)));
  }
  for (const id of store.sessionIds()) {
    const events = store.events(id);
    fs.writeFileSync(path.join(destination, "sessions", id, "events.ndjson"), events.map((event) => JSON.stringify(event) + "\n").join(""), { mode: 0o600 });
  }
}

function directorySize(directory: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const inner = directorySize(child);
      bytes += inner.bytes;
      files += inner.files;
    } else {
      try {
        bytes += fs.statSync(child).size;
        files += 1;
      } catch {}
    }
  }
  return { bytes, files };
}

/** Removes the import's backup once it is older than the retention; its age falls back to the directory's mtime. */
export function sweepLegacyBackup(store: ExecutionStore, retentionMs: number): ExecutionHousekeeping["backup"] {
  const backup = path.join(store.root, "execution-json-backup");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(backup);
  } catch {
    return undefined;
  }
  if (!stat.isDirectory()) return undefined;
  const { bytes, files } = directorySize(backup);
  if (files === 0) {
    fs.rmSync(backup, { recursive: true, force: true });
    return undefined;
  }
  const stamped = store.statement("SELECT value FROM metadata WHERE key='imported-at'").get();
  const importedAt = stamped ? Number(stamped.value) : stat.mtimeMs;
  const ageMs = store.now() - (Number.isFinite(importedAt) ? importedAt : stat.mtimeMs);
  if (ageMs < retentionMs) return { removed: false, bytes, files, ageMs };
  fs.rmSync(backup, { recursive: true, force: true });
  return { removed: true, bytes, files, ageMs };
}
