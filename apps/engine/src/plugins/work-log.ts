/**
 * BREADCRUMBS FOR WORK THAT OUTLIVES NOTHING.
 *
 * A plugin's running work lives in memory — `JobRunner`'s map, `KernelHost`'s
 * kernels, `latexCompiles`. That is fine for the work itself; a compile cannot
 * survive the daemon that spawned it. It is NOT fine for what we then TELL the
 * user about it, and that gap is a correctness bug rather than a cosmetic one:
 *
 *     a compile is running → daemon restarts → the map is empty →
 *     `latex_status` answers "never compiled"
 *
 * "Never" is false. The honest answer is "a compile was interrupted when the
 * engine restarted", and the difference matters to somebody staring at a PDF
 * that never appeared, wondering whether to wait.
 *
 * So each piece of long-running work drops a breadcrumb before it starts and
 * removes it when it ends. A breadcrumb stamped with a DIFFERENT daemon id than
 * the one now running can only mean the process died holding it — nothing else
 * can produce that state — so startup sweeps those into "interrupted" and the
 * plugin reports them.
 *
 * WHY ONE FILE PER RECORD rather than one document with a map: several plugins
 * begin and end work concurrently, and a shared document would need a lock to
 * avoid a read-modify-write race losing a neighbour's entry. A directory of
 * small files gets that for free from the filesystem.
 *
 * A breadcrumb is not a queue and not a resume point. It records THAT work was
 * lost, never enough to redo it — recovery, if a plugin ever wants it, is the
 * plugin's own durable state, not this.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic";

export type PluginWorkRecord = {
  /** Opaque handle, returned by `begin` and passed back to `end`. */
  id: string;
  plugin: string;
  /** Which session's work this is, so a report can be scoped. */
  sessionId: string;
  /** The plugin's own word for the work: `compile`, `cell`, `install`. */
  kind: string;
  /** Something a human can recognise: a filename, a cell number. */
  label?: string;
  startedAt: string;
  /** The daemon generation that started it. THE FIELD THE SWEEP READS. */
  daemonId: string;
};

const isRecord = (value: unknown): value is PluginWorkRecord => {
  if (!value || typeof value !== "object") return false;
  const it = value as Partial<PluginWorkRecord>;
  return (
    typeof it.id === "string" &&
    typeof it.plugin === "string" &&
    typeof it.sessionId === "string" &&
    typeof it.kind === "string" &&
    typeof it.daemonId === "string" &&
    typeof it.startedAt === "string"
  );
};

export class PluginWorkLog {
  constructor(
    private readonly dir: string,
    private readonly daemonId: string,
  ) {}

  private file(id: string): string {
    // Ids are minted here, but `end` takes one back from a caller — so refuse
    // anything that could escape the directory rather than trusting it.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid work id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  /** Record that work is starting. Returns the handle `end` needs. */
  begin(entry: { plugin: string; sessionId: string; kind: string; label?: string }): string {
    const id = `w_${crypto.randomUUID().replaceAll("-", "")}`;
    const record: PluginWorkRecord = {
      id,
      plugin: entry.plugin,
      sessionId: entry.sessionId,
      kind: entry.kind,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      startedAt: new Date().toISOString(),
      daemonId: this.daemonId,
    };
    atomicWrite(this.file(id), record);
    return id;
  }

  /**
   * Work finished — however it finished. Success, failure and cancellation all
   * remove the breadcrumb, because the breadcrumb's only claim is "this was
   * still running when the process was last alive"; the OUTCOME is reported by
   * whatever the plugin already returns.
   */
  end(id: string): void {
    try {
      fs.unlinkSync(this.file(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private read(): PluginWorkRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: PluginWorkRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const value = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as unknown;
        if (isRecord(value)) records.push(value);
        else fs.unlinkSync(path.join(this.dir, name)); // unreadable: not evidence of anything
      } catch {
        // A torn or unreadable breadcrumb tells us nothing we can report. Drop
        // it rather than letting one bad file make every later sweep throw.
        try {
          fs.unlinkSync(path.join(this.dir, name));
        } catch {
          /* already gone */
        }
      }
    }
    return records;
  }

  /** Work this daemon believes is still running. */
  active(): PluginWorkRecord[] {
    return this.read().filter((record) => record.daemonId === this.daemonId);
  }

  /**
   * Work a PREVIOUS daemon generation was holding when it died. Claiming is
   * destructive on purpose: interrupted work is reported once, and a second
   * restart must not resurrect the same notice forever.
   */
  claimInterrupted(): PluginWorkRecord[] {
    const stale = this.read().filter((record) => record.daemonId !== this.daemonId);
    for (const record of stale) this.end(record.id);
    return stale;
  }
}
