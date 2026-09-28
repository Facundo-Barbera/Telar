import crypto from "node:crypto";
import type { ItemDetail, ItemSeed, TurnObservation, UsageSnapshot } from "@telar/engine-client";
import { codexItemDetail, codexItemFailed, codexItemStatus, codexPlanDetail, codexUsage, record, str } from "./items";

export const codexRowId = (codexId: string): string => `item_${codexId}`;

/** Folds one turn's app-server notifications into observations. A child thread is a sub-agent task. */
export class CodexTurn {
  text = "";
  usage: UsageSnapshot | undefined;
  threadId = "";
  turnId = "";
  private readonly open = new Map<string, { id: string; detail: ItemDetail }>();
  // Codex re-publishes some items as later snapshots; a closed id must not reopen a row.
  private readonly closed = new Set<string>();
  private readonly streamed = new Map<string, string>();
  private readonly childTasks = new Set<string>();
  private planItemId: string | undefined;

  constructor(private readonly emit: (observation: TurnObservation) => void) {}

  /** True once the root turn completed. Throws on the root thread's terminal failure. */
  handle(method: string, params: Record<string, unknown>): boolean {
    const threadId = str(params.threadId) ?? "";
    switch (method) {
      case "item/started":
      case "item/completed":
        this.item(threadId, params.item, method === "item/completed");
        return false;
      case "item/agentMessage/delta":
        this.delta(threadId, params, "assistant");
        return false;
      case "item/reasoning/textDelta":
        this.delta(threadId, params, "reasoning");
        return false;
      case "turn/plan/updated":
        if (threadId === this.threadId) this.plan(params);
        return false;
      case "thread/tokenUsage/updated":
        if (threadId === this.threadId) this.tokenUsage(params);
        return false;
      case "error":
        this.error(threadId, params);
        return false;
      case "turn/completed":
        return this.completed(threadId, record(params.turn));
      default:
        return false;
    }
  }

  private taskIdFor(threadId: string): string | undefined {
    return threadId && this.threadId && threadId !== this.threadId ? `task_${threadId}` : undefined;
  }

  private noteThread(threadId: string): string | undefined {
    const taskId = this.taskIdFor(threadId);
    if (!taskId || this.childTasks.has(threadId)) return taskId;
    this.childTasks.add(threadId);
    this.emit({ kind: "task.started", task: { id: taskId, kind: "agent", state: "running", providerTaskId: threadId } });
    return taskId;
  }

  private closeThreadTask(threadId: string, state: "completed" | "failed"): void {
    const taskId = this.taskIdFor(threadId);
    if (!taskId || !this.childTasks.delete(threadId)) return;
    this.emit({ kind: "task.completed", task: { id: taskId, kind: "agent", state, providerTaskId: threadId } });
  }

  private refsFor(codexId: string, threadId: string): ItemSeed["providerRefs"] {
    return {
      itemId: codexId,
      ...(this.turnId ? { turnId: this.turnId } : {}),
      ...(threadId && threadId !== this.threadId ? { sessionId: threadId } : {}),
    };
  }

  private openItem(threadId: string, codexId: string, detail: ItemDetail, title?: string): string {
    const existing = this.open.get(codexId);
    if (existing) return existing.id;
    const id = codexRowId(codexId);
    const taskId = this.noteThread(threadId);
    this.open.set(codexId, { id, detail });
    this.emit({
      kind: "item.started",
      item: { id, detail, ...(title ? { title } : {}), ...(taskId ? { taskId } : {}), providerRefs: this.refsFor(codexId, threadId) },
    });
    return id;
  }

  private item(threadId: string, raw: unknown, terminal: boolean): void {
    const item = record(raw);
    const codexId = str(item.id);
    if (!codexId || this.closed.has(codexId)) return;
    const mapped = codexItemDetail(item);
    if (!mapped) return;
    const id = this.openItem(threadId, codexId, mapped.detail, mapped.title);
    if (!terminal) return;
    this.open.delete(codexId);
    this.closed.add(codexId);

    const status = codexItemStatus(item.status, "completed");
    let detail = mapped.detail;
    const streamed = this.streamed.get(codexId);
    if (detail.type === "assistant_message") {
      // `agentMessage` re-sends its full text on completion; only an unstreamed root message joins the answer.
      if (streamed === undefined && threadId === this.threadId) this.text += detail.text;
      if (detail.text.length === 0 && streamed) detail = { type: "assistant_message", text: streamed };
    }
    if (detail.type === "reasoning" && streamed) detail = { type: "reasoning", text: streamed };
    this.emit({ kind: "item.completed", itemId: id, status: codexItemFailed(item, status) ? "failed" : status, detail });
  }

  private delta(threadId: string, params: Record<string, unknown>, kind: "assistant" | "reasoning"): void {
    const codexId = str(params.itemId);
    const text = typeof params.delta === "string" ? params.delta : undefined;
    if (!codexId || !text || this.closed.has(codexId)) return;
    const id = this.openItem(
      threadId,
      codexId,
      kind === "assistant" ? { type: "assistant_message", text: "" } : { type: "reasoning", text: "" },
    );
    this.streamed.set(codexId, (this.streamed.get(codexId) ?? "") + text);
    if (kind === "assistant" && threadId === this.threadId) this.text += text;
    this.emit({ kind: "content.delta", itemId: id, stream: kind === "assistant" ? "assistant_text" : "reasoning_text", text });
  }

  private plan(params: Record<string, unknown>): void {
    const detail = codexPlanDetail(params);
    if (!detail) return;
    if (this.planItemId) {
      this.emit({ kind: "item.updated", item: { id: this.planItemId, detail } });
      return;
    }
    this.planItemId = `item_plan_${crypto.randomUUID().replaceAll("-", "")}`;
    this.emit({ kind: "item.started", item: { id: this.planItemId, detail, title: "Plan" } });
  }

  private tokenUsage(params: Record<string, unknown>): void {
    const snapshot = codexUsage(params);
    if (!snapshot) return;
    this.usage = snapshot;
    this.emit({ kind: "usage", usage: snapshot });
  }

  private error(threadId: string, params: Record<string, unknown>): void {
    const message = str(record(params.error).message) ?? "Codex reported an error";
    if (threadId === this.threadId && params.willRetry !== true) throw new Error(message);
    const id = `item_error_${crypto.randomUUID().replaceAll("-", "")}`;
    const taskId = this.noteThread(threadId);
    this.emit({ kind: "item.started", item: { id, detail: { type: "error", error: { message } }, ...(taskId ? { taskId } : {}) } });
    this.emit({ kind: "item.completed", itemId: id, status: "failed" });
  }

  private completed(threadId: string, turn: Record<string, unknown>): boolean {
    if (threadId !== this.threadId) {
      this.closeThreadTask(threadId, turn.status === "failed" ? "failed" : "completed");
      return false;
    }
    if (this.turnId && str(turn.id) && str(turn.id) !== this.turnId) return false;
    if (turn.status === "failed") throw new Error(str(record(turn.error).message) ?? "Codex turn failed");
    for (const [, row] of this.open) this.emit({ kind: "item.completed", itemId: row.id, status: "failed" });
    this.open.clear();
    for (const child of this.childTasks) this.closeThreadTask(child, "failed");
    if (this.planItemId) this.emit({ kind: "item.completed", itemId: this.planItemId, status: "completed" });
    return true;
  }
}
