import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../../platform/fs/atomic";

export type PluginWorkRecord = {
  id: string;
  plugin: string;
  sessionId: string;
  kind: string;
  label?: string;
  startedAt: string;
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
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid work id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

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
        else fs.unlinkSync(path.join(this.dir, name));
      } catch {
        try {
          fs.unlinkSync(path.join(this.dir, name));
        } catch {
        }
      }
    }
    return records;
  }

  active(): PluginWorkRecord[] {
    return this.read().filter((record) => record.daemonId === this.daemonId);
  }

  claimInterrupted(): PluginWorkRecord[] {
    const stale = this.read().filter((record) => record.daemonId !== this.daemonId);
    for (const record of stale) this.end(record.id);
    return stale;
  }
}
