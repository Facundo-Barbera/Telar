/**
 * Everything the data-science tools keep beside a session, under
 * `sessions/<id>/ds/`. Plain files, written atomically like the rest of the
 * store; a corrupt one costs that file's history, never the session.
 *
 *   snapshots/<name>.json   a namespace summary — shapes, dtypes, stats, digests
 *   checkpoints/<name>.pkl  the namespace itself, pickled by the kernel
 *   watches.json            assertions re-evaluated after every execution
 *   lineage.ndjson          which cell/tool touched which variable, append-only
 *   experiments.json        params and metrics per run
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic";

export type Snapshot = { name: string; at: number; vars: Record<string, SnapshotVar> };
export type SnapshotVar = {
  type: string;
  shape?: number[];
  len?: number;
  columns?: string[];
  dtypes?: string[];
  nulls?: Record<string, number>;
  stats?: Record<string, Record<string, number | null>>;
  digest?: string;
  repr?: string;
  error?: string;
};

export type Watch = { name: string; assert: string; createdAt: number; lastResult?: { ok: boolean; at: number; detail?: string } };
export type LineageRow = { at: number; producer: string; code: string; assigned: string[]; read: string[] };
export type Experiment = { name: string; startedAt: number; endedAt?: number; params: Record<string, unknown>; metrics: Record<string, number>[] };

export class DsFiles {
  constructor(private readonly dir: string) {}

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(name: string, value: unknown): void {
    fs.mkdirSync(path.dirname(this.file(name)), { recursive: true });
    atomicWrite(this.file(name), value);
  }

  // ── snapshots ─────────────────────────────────────────────────────────
  saveSnapshot(snapshot: Snapshot): void {
    this.writeJson(`snapshots/${safe(snapshot.name)}.json`, snapshot);
  }
  readSnapshot(name: string): Snapshot | undefined {
    return this.readJson<Snapshot | undefined>(`snapshots/${safe(name)}.json`, undefined);
  }
  listSnapshots(): { name: string; at: number }[] {
    return this.listDir("snapshots", ".json").map((name) => this.readSnapshot(name)).filter((s): s is Snapshot => Boolean(s)).map(({ name, at }) => ({ name, at }));
  }

  // ── checkpoints ───────────────────────────────────────────────────────
  checkpointPath(name: string): string {
    fs.mkdirSync(this.file("checkpoints"), { recursive: true });
    return this.file(`checkpoints/${safe(name)}.pkl`);
  }
  listCheckpoints(): { name: string; bytes: number; at: number }[] {
    return this.listDir("checkpoints", ".pkl").map((name) => {
      const stat = fs.statSync(this.file(`checkpoints/${name}.pkl`));
      return { name, bytes: stat.size, at: stat.mtimeMs };
    });
  }

  // ── watches ───────────────────────────────────────────────────────────
  watches(): Watch[] {
    return this.readJson<{ watches: Watch[] }>("watches.json", { watches: [] }).watches;
  }
  saveWatches(watches: Watch[]): void {
    this.writeJson("watches.json", { watches });
  }

  // ── lineage ───────────────────────────────────────────────────────────
  appendLineage(row: LineageRow): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file("lineage.ndjson"), `${JSON.stringify(row)}\n`);
  }
  lineage(): LineageRow[] {
    try {
      return fs.readFileSync(this.file("lineage.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LineageRow);
    } catch {
      return [];
    }
  }

  // ── experiments ───────────────────────────────────────────────────────
  experiments(): Experiment[] {
    return this.readJson<{ experiments: Experiment[] }>("experiments.json", { experiments: [] }).experiments;
  }
  saveExperiments(experiments: Experiment[]): void {
    this.writeJson("experiments.json", { experiments });
  }

  private listDir(sub: string, ext: string): string[] {
    try {
      return fs.readdirSync(this.file(sub)).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length));
    } catch {
      return [];
    }
  }
}

/** A name that is a filename and nothing else. */
export function safe(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  if (!cleaned) throw new Error("name must contain a letter or digit");
  return cleaned;
}

/**
 * Which names a cell assigns and which it reads — a regex over the source,
 * good enough for lineage, and deliberately not a parser: the goal is "what
 * do I rerun if I change this", not correctness under `exec`.
 */
export function namesIn(code: string): { assigned: string[]; read: string[] } {
  const assigned = new Set<string>();
  const read = new Set<string>();
  for (const line of code.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*\s*(?:\[[^\]]*\])?\s*(?:[+\-*/|&^%]|\/\/|\*\*)?=(?!=)/.exec(trimmed);
    if (assign) for (const name of trimmed.split("=")[0]!.split(",")) { const n = name.trim().split("[")[0]!.trim(); if (/^[A-Za-z_]\w*$/.test(n)) assigned.add(n); }
    const fn = /^def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (fn) assigned.add(fn[1] ?? fn[2]!);
    const imp = /^(?:from\s+\S+\s+)?import\s+(.+)$/.exec(trimmed);
    if (imp) for (const part of imp[1]!.split(",")) { const alias = part.trim().split(/\s+as\s+/); assigned.add((alias[1] ?? alias[0]!).split(".")[0]!.trim()); }
    for (const match of trimmed.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
      const name = match[1]!;
      if (!assigned.has(name) && !KEYWORDS.has(name)) read.add(name);
    }
  }
  for (const name of assigned) read.delete(name);
  return { assigned: [...assigned], read: [...read] };
}

const KEYWORDS = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield print len range str int float list dict set tuple".split(" "));
