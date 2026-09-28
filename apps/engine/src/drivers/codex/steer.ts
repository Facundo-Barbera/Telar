import crypto from "node:crypto";
import type { ItemDetail, TurnObservation } from "@telar/engine-client";
import { framedSteerText, steerRowTitle } from "../../domains/turns";
import type { SteerMailbox, SteerMessage } from "../../steering";
import type { CodexAppServer } from "./app-server";
import { attachedFilesText, codexNotificationInstruction, codexTurnInput } from "./thread";
import { codexRowId, type CodexTurn } from "./turn";

// `turn/steer` has no developer channel, so a steered notification carries its header in the text.
function steerText(message: SteerMessage): string {
  const words = message.notification ? codexNotificationInstruction(message.notification, framedSteerText(message)) : framedSteerText(message);
  const files = (message.attachments ?? []).filter((file) => !file.mediaType.startsWith("image/"));
  return files.length === 0 ? words : `${words}\n\n${attachedFilesText(files)}`;
}

function steerRow(message: SteerMessage): ItemDetail {
  if (message.notification) return { type: "notification", notification: message.notification };
  const files = message.attachments ?? [];
  return {
    type: "user_message",
    text: message.text,
    ...(files.length > 0 ? { attachments: files } : {}),
    ...(message.sender ? { sender: message.sender } : {}),
    ...(message.notice ? { notice: message.notice } : {}),
    ...(message.wakeReason ? { wakeReason: message.wakeReason } : {}),
  };
}

/** Sends steered messages into the running turn until the mailbox closes. A refusal becomes an error row. */
export async function pumpCodexSteers(
  steer: SteerMailbox,
  client: CodexAppServer,
  turn: CodexTurn,
  emit: (observation: TurnObservation) => void,
): Promise<void> {
  for (;;) {
    await steer.wake();
    const queued = steer.drain();
    if (queued.length === 0) {
      if (steer.isClosed) return;
      continue;
    }
    const images = queued.flatMap((message) => (message.attachments ?? []).filter((file) => file.mediaType.startsWith("image/")));
    const text = queued.map(steerText).join("\n\n");
    for (const message of queued) {
      const rowId = codexRowId(`steer-${crypto.randomUUID().slice(0, 8)}`);
      emit({ kind: "item.started", item: { id: rowId, detail: steerRow(message), title: steerRowTitle(message) } });
      emit({ kind: "item.completed", itemId: rowId, status: "completed" });
    }
    try {
      await client.request("turn/steer", { threadId: turn.threadId, expectedTurnId: turn.turnId, input: codexTurnInput(text, images) });
    } catch (error) {
      const errorId = codexRowId(`steer-error-${crypto.randomUUID().slice(0, 8)}`);
      const message = `The sent-now message could not reach the running turn: ${error instanceof Error ? error.message : String(error)}`;
      emit({ kind: "item.started", item: { id: errorId, detail: { type: "error", error: { message } } } });
      emit({ kind: "item.completed", itemId: errorId, status: "failed" });
    }
  }
}
