/**
 * A durable LangGraph checkpoint saver over `bun:sqlite`.
 *
 * `@langchain/langgraph-checkpoint-sqlite` cannot be used here: it binds
 * `better-sqlite3`, a native module Bun does not load (oven-sh/bun#4290).
 * This is a port of that saver onto Bun's built-in driver, keeping the same
 * two-table schema so the files are interchangeable.
 */
import { Database } from "bun:sqlite";
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  copyCheckpoint,
  maxChannelVersion,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

const PENDING_WRITES_SUBQUERY = `
  (
    SELECT json_group_array(json_object(
      'task_id', pw.task_id, 'channel', pw.channel,
      'type', pw.type, 'value', CAST(pw.value AS TEXT)))
    FROM writes AS pw
    WHERE pw.thread_id = checkpoints.thread_id
      AND pw.checkpoint_ns = checkpoints.checkpoint_ns
      AND pw.checkpoint_id = checkpoints.checkpoint_id
  ) AS pending_writes`;

const SELECT_COLUMNS = `
  thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
  type, checkpoint, metadata,${PENDING_WRITES_SUBQUERY}`;

/** bun:sqlite rejects `undefined` bindings; the driver only speaks `null`. */
const bind = (v: unknown) => (v === undefined ? null : v);

export class BunSqliteSaver extends BaseCheckpointSaver {
  db: Database;
  private isSetup = false;

  constructor(db: Database, serde?: SerializerProtocol) {
    super(serde);
    this.db = db;
  }

  static fromConnString(path: string): BunSqliteSaver {
    return new BunSqliteSaver(new Database(path));
  }

  private setup() {
    if (this.isSetup) return;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);`);
    this.db.exec(`
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);`);
    this.isSetup = true;
  }

  private async hydrate(row: any, checkpoint_ns: string): Promise<{
    checkpoint: Checkpoint;
    metadata: CheckpointMetadata;
    pendingWrites: [string, string, unknown][];
  }> {
    const pendingWrites = await Promise.all(
      JSON.parse(row.pending_writes).map(async (w: any) => [
        w.task_id,
        w.channel,
        await this.serde.loadsTyped(w.type ?? "json", w.value ?? ""),
      ]),
    );
    const checkpoint = (await this.serde.loadsTyped(row.type ?? "json", row.checkpoint)) as Checkpoint;
    if ((checkpoint as any).v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(checkpoint, row.thread_id, row.parent_checkpoint_id, checkpoint_ns);
    }
    const metadata = (await this.serde.loadsTyped(row.type ?? "json", row.metadata)) as CheckpointMetadata;
    return { checkpoint, metadata, pendingWrites: pendingWrites as [string, string, unknown][] };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const { thread_id, checkpoint_ns = "", checkpoint_id } = config.configurable ?? {};
    const sql = `SELECT ${SELECT_COLUMNS} FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ${
      checkpoint_id ? "AND checkpoint_id = ?" : "ORDER BY checkpoint_id DESC LIMIT 1"
    }`;
    const args = checkpoint_id ? [thread_id, checkpoint_ns, checkpoint_id] : [thread_id, checkpoint_ns];
    const row: any = this.db.prepare(sql).get(...(args.map(bind) as any[]));
    if (row == null) return undefined;

    const finalConfig = checkpoint_id
      ? config
      : { configurable: { thread_id: row.thread_id, checkpoint_ns, checkpoint_id: row.checkpoint_id } };
    const { checkpoint, metadata, pendingWrites } = await this.hydrate(row, checkpoint_ns);
    return {
      checkpoint,
      config: finalConfig,
      metadata,
      parentConfig: row.parent_checkpoint_id
        ? { configurable: { thread_id: row.thread_id, checkpoint_ns, checkpoint_id: row.parent_checkpoint_id } }
        : undefined,
      pendingWrites,
    };
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    this.setup();
    const { limit, before, filter } = options ?? {};
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns;

    const where: string[] = [];
    if (thread_id) where.push("thread_id = ?");
    if (checkpoint_ns != null) where.push("checkpoint_ns = ?");
    if (before?.configurable?.checkpoint_id !== undefined) where.push("checkpoint_id < ?");
    const sanitized = Object.fromEntries(Object.entries(filter ?? {}).filter(([, v]) => v !== undefined));
    where.push(...Object.keys(sanitized).map(() => "jsonb(CAST(metadata AS TEXT))->? = ?"));

    let sql = `SELECT ${SELECT_COLUMNS} FROM checkpoints`;
    if (where.length > 0) sql += `\nWHERE ${where.join(" AND ")}`;
    sql += "\nORDER BY checkpoint_id DESC";
    if (limit) sql += ` LIMIT ${parseInt(String(limit), 10)}`;

    const args = [
      thread_id,
      checkpoint_ns,
      before?.configurable?.checkpoint_id,
      ...Object.entries(sanitized).flatMap(([k, v]) => [`$.${k}`, JSON.stringify(v)]),
    ].filter((v) => v !== undefined && v !== null);

    for (const row of this.db.prepare(sql).all(...(args as any[])) as any[]) {
      const ns = row.checkpoint_ns;
      const { checkpoint, metadata, pendingWrites } = await this.hydrate(row, ns);
      yield {
        config: { configurable: { thread_id: row.thread_id, checkpoint_ns: ns, checkpoint_id: row.checkpoint_id } },
        checkpoint,
        metadata,
        parentConfig: row.parent_checkpoint_id
          ? { configurable: { thread_id: row.thread_id, checkpoint_ns: ns, checkpoint_id: row.parent_checkpoint_id } }
          : undefined,
        pendingWrites,
      };
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    this.setup();
    if (!config.configurable) throw new Error("Empty configuration supplied.");
    const thread_id = config.configurable.thread_id;
    const checkpoint_ns = config.configurable.checkpoint_ns ?? "";
    const parent_checkpoint_id = config.configurable.checkpoint_id;
    if (!thread_id) throw new Error(`Missing "thread_id" field in passed "config.configurable".`);

    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    if (type1 !== type2) throw new Error("Failed to serialized checkpoint and metadata to the same type.");

    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...([thread_id, checkpoint_ns, checkpoint.id, parent_checkpoint_id, type1, serializedCheckpoint, serializedMetadata].map(
          bind,
        ) as any[]),
      );

    return { configurable: { thread_id, checkpoint_ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    this.setup();
    if (!config.configurable) throw new Error("Empty configuration supplied.");
    const { thread_id, checkpoint_ns, checkpoint_id } = config.configurable;
    if (!thread_id) throw new Error("Missing thread_id field in config.configurable.");
    if (!checkpoint_id) throw new Error("Missing checkpoint_id field in config.configurable.");

    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const stmt = this.db.prepare(
      `INSERT ${allSpecial ? "OR REPLACE" : "OR IGNORE"} INTO writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const rows = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, serialized] = await this.serde.dumpsTyped(write[1]);
        return [
          thread_id,
          checkpoint_ns ?? "",
          checkpoint_id,
          taskId,
          WRITES_IDX_MAP[write[0]] ?? idx,
          write[0],
          type,
          serialized,
        ].map(bind);
      }),
    );
    this.db.transaction((batch: any[][]) => {
      for (const row of batch) stmt.run(...(row as any[]));
    })(rows);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.setup();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
      this.db.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
    })();
  }

  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentCheckpointId: string,
    checkpointNs: string,
  ) {
    const row: any = this.db
      .prepare(
        `SELECT json_group_array(json_object('type', ps.type, 'value', CAST(ps.value AS TEXT))) AS pending_sends
         FROM writes AS ps
         WHERE ps.thread_id = ? AND ps.checkpoint_ns = ? AND ps.checkpoint_id = ? AND ps.channel = ?
         ORDER BY ps.idx`,
      )
      .get(threadId, checkpointNs, parentCheckpointId, TASKS);
    const mutable = checkpoint as any;
    mutable.channel_values ??= {};
    mutable.channel_values[TASKS] = await Promise.all(
      JSON.parse(row?.pending_sends ?? "[]").map(({ type, value }: any) => this.serde.loadsTyped(type, value)),
    );
    mutable.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions as Record<string, string | number>))
        : this.getNextVersion(undefined);
  }
}
