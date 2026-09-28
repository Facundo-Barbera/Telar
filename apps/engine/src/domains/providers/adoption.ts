import crypto from "node:crypto";
import path from "node:path";
import { defaultInstanceIdForDriver, type ConversationImportDetail, type EngineEvent, type Item, type ProviderInstance, type ProviderDriverKind, type Session, type Turn } from "@telar/engine-client";
import { adoptClaudeConversation, type Adoption, type ClaudeConversation, describeAdoption, describeImport, type ForkCut, listAdoptableConversations } from "../../drivers/claude";
import { EngineStateError, type JournalEntry } from "../../platform/kernel";
import type { SessionItems, SessionQueue, SessionRecords } from "../sessions";
import { MAX_TEXT_LENGTH } from "../turns";
import { providerProcessEnv } from "./instances";

export type AdoptionHost = {
  engineRoot: string;
  now(): number;
  resolveInstance(instanceId: string, driver: ProviderDriverKind): ProviderInstance;
  readQueue(sessionId: string): SessionQueue;
  writeQueue(sessionId: string, queue: SessionQueue): void;
  appendEvent(sessionId: string, event: JournalEntry, runId?: string): EngineEvent;
};

export type AdoptionInput = { sourceSessionId: string; cut?: ForkCut; sourceCwd?: string; maxRows?: number };

/**
 * The config directory the child resolves: the instance's patch over this process's env, where a
 * patch that deletes `CLAUDE_CONFIG_DIR` means the default location even if the engine inherited one.
 */
function claudeConfigDir(instance: ProviderInstance): string | undefined {
  const patch = providerProcessEnv(instance);
  if (Object.hasOwn(patch, "CLAUDE_CONFIG_DIR")) return patch.CLAUDE_CONFIG_DIR?.trim() || undefined;
  return process.env.CLAUDE_CONFIG_DIR?.trim() || undefined;
}

/** Adopting a Claude Code conversation (`/resume`): listing a login's history and forking one into a new session. */
export class ConversationAdoption {
  constructor(
    private readonly records: SessionRecords,
    private readonly items: SessionItems,
    private readonly host: AdoptionHost,
  ) {}

  /** Shared by the fork and the listing, so "relocated there" and "a fork there is ours" cannot disagree. */
  private get forkHome(): string {
    return path.join(this.host.engineRoot, "adopted");
  }

  /** Scoped to a login, not a session: the picker runs before the session it would adopt into exists. */
  list(options: { instanceId?: string; cwd?: string; limit?: number } = {}): Promise<ClaudeConversation[]> {
    const instance = this.host.resolveInstance(options.instanceId ?? defaultInstanceIdForDriver("claude"), "claude");
    if (instance.driver !== "claude") {
      throw new EngineStateError("invalid_request", "only a Claude login has Claude Code conversations");
    }
    const configDir = claudeConfigDir(instance);
    return listAdoptableConversations({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(configDir ? { configDir } : {}),
      forkHome: this.forkHome,
    });
  }

  /**
   * Writes one `import` turn holding the history (provenance first), then the fork's cursor last, so a
   * crash in between never resumes a history the session does not show. Refused once a session has
   * spoken: the cursor would jump mid-thread while the transcript kept the old turns.
   */
  async adopt(sessionId: string, input: AdoptionInput): Promise<{ session: Session; turn: Turn; provenance: ConversationImportDetail }> {
    const session = this.records.get(sessionId);
    if (session.driver !== "claude") {
      throw new EngineStateError("invalid_request", "only a Claude session can adopt a Claude Code conversation");
    }
    const queue = this.host.readQueue(sessionId);
    if (queue.turns.length > 0 || session.resumeCursor) {
      throw new EngineStateError("conflict", "this session has already started a conversation — adopt into a new session instead");
    }
    let adoption: Adoption;
    try {
      const configDir = claudeConfigDir(this.host.resolveInstance(session.providerInstanceId, session.driver));
      adoption = await adoptClaudeConversation({
        sourceSessionId: input.sourceSessionId,
        title: session.title,
        ...(input.cut ? { cut: input.cut } : {}),
        ...(input.sourceCwd ? { sourceCwd: input.sourceCwd } : {}),
        ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
        ...(configDir ? { configDir } : {}),
        forkHome: this.forkHome,
      });
    } catch (error) {
      throw new EngineStateError("invalid_request", error instanceof Error ? error.message : String(error));
    }

    const at = this.host.now();
    const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
    const turn: Turn = {
      runId,
      sessionId,
      sequence: queue.nextSequence++,
      input: describeAdoption(adoption.provenance).slice(0, MAX_TEXT_LENGTH),
      kind: "import",
      state: "completed",
      acceptedAt: at,
      startedAt: at,
      updatedAt: at,
      completedAt: at,
      providerSessionId: adoption.fork.sessionId,
      resultText: describeImport(adoption.read),
    };
    queue.turns.push(turn);
    this.host.writeQueue(sessionId, queue);

    const items = this.items.read(sessionId);
    const stamp: Item = {
      id: `import_${runId}`,
      runId,
      sessionId,
      status: "completed",
      title: describeAdoption(adoption.provenance),
      detail: { type: "conversation_import", import: adoption.provenance },
      startedAt: at,
      completedAt: at,
    };
    items.set(stamp.id, stamp);
    const written: Item[] = [stamp];
    // Ids derive from the run and index, so a retry after a crash replaces its own rows instead of doubling them.
    adoption.rows.forEach((row, index) => {
      const item: Item = {
        id: `imported_${runId}_${index}`,
        runId,
        sessionId,
        status: row.status,
        ...(row.title ? { title: row.title } : {}),
        detail: row.detail,
        startedAt: row.startedAt,
        ...(row.completedAt !== undefined ? { completedAt: row.completedAt } : {}),
        providerRefs: row.providerRefs,
        imported: true,
      };
      items.set(item.id, item);
      written.push(item);
    });
    this.items.write(sessionId, items, new Set(written.map((row) => row.id)));

    this.host.appendEvent(sessionId, { type: "turn.accepted", turn, replayed: false }, runId);
    for (const item of written) {
      this.host.appendEvent(sessionId, { type: "item.started", item }, runId);
      this.host.appendEvent(sessionId, { type: "item.completed", item }, runId);
    }
    this.host.appendEvent(sessionId, { type: "turn.completed", resultText: turn.resultText ?? "" }, runId);

    this.records.touch(sessionId, at, adoption.fork.sessionId);
    return { session: this.records.get(sessionId), turn: structuredClone(turn), provenance: adoption.provenance };
  }
}
