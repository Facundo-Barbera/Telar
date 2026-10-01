"use client";

import {
TriangleAlertIcon
} from "lucide-react";
import { ArtifactCard } from "@/features/agent-tools";
import { isToolItem, itemLabel, itemText, type JournalItem, type JournalTask } from "@/platform/engine";
import { MessageMenu, MessageResponse } from "@/ui/message";
import { type OpenTab } from "./conversation-message";
import { RowGestures, ToolRow } from "./tool-row";
import { running, transcriptTasks } from "../model";
import { AgentRow, CompactionRow, ConversationImportRow, PlanRow, PlotRow, ProviderWaitRow, ReasoningRow, SteeredMessageRow } from "./item-rows";
import { NotificationRow } from "./notification-row";

export function TranscriptItem({ item, tasks, onOpenAgent, onOpenTab, onInsert, onOpenFile, onOpenFileInNewTab }: {
  item: JournalItem;
  tasks?: readonly JournalTask[];
  onOpenAgent?: (taskId: string) => void;
  /** So a message steered into a running turn opens its references exactly
   *  as the same message sent idle does. */
  onOpenTab?: OpenTab;
} & RowGestures) {
  const gestures = { ...(onInsert ? { onInsert } : {}), ...(onOpenFile ? { onOpenFile } : {}), ...(onOpenFileInNewTab ? { onOpenFileInNewTab } : {}) };
  if (item.detail.type === "task") {
    const taskId = item.detail.taskId;
    const task = tasks?.find((candidate) => candidate.id === taskId);
    // A backgrounded SHELL spawned as a task is the `Ran command` row already
    // beside it; only a delegate earns an agent row.
    if (task && !transcriptTasks([task]).length) return null;
    return <AgentRow item={item} task={task} {...(onOpenAgent ? { onOpen: onOpenAgent } : {})} {...(onInsert ? { onInsert } : {})} />;
  }
  if (item.detail.type === "artifact") return <ArtifactCard sessionId={item.sessionId} artifact={item.detail.artifact} />;
  if (item.detail.type === "plan") return <PlanRow item={item} />;
  if (item.detail.type === "reasoning") return <ReasoningRow item={item} />;
  if (item.detail.type === "context_compaction") return <CompactionRow item={item} />;
  if (item.detail.type === "conversation_import") return <ConversationImportRow item={item} />;
  if (item.detail.type === "provider_wait") return <ProviderWaitRow item={item} />;
  // A NOTIFICATION IS NOT A MESSAGE ROW OF ANY KIND — #550. Its own arm, above
  // `user_message`, because the whole point of the type is that narrowing on it
  // is what gives you the payload: there is no field left to forget to check.
  if (item.detail.type === "notification") return <NotificationRow detail={item.detail.notification} />;
  if (item.detail.type === "user_message") return <SteeredMessageRow item={item} {...(onOpenTab ? { onOpenTab } : {})} {...(onInsert ? { onInsert } : {})} />;
  if (item.plotAttachmentId) return <PlotRow item={item} attachmentId={item.plotAttachmentId} />;
  if (isToolItem(item)) return <ToolRow item={item} {...gestures} />;
  if (item.detail.type === "error") {
    return (
      <p role="alert" className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-1.5 py-1 text-xs text-destructive">
        <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
        {item.detail.error.message}
      </p>
    );
  }
  if (item.detail.type === "assistant_message") {
    // NO MENU WHILE IT IS STILL BEING WRITTEN. Copying or quoting half a
    // sentence gives you half a sentence, and the reader cannot tell from the
    // clipboard that the rest arrived a moment later.
    const text = itemText(item);
    if (running(item)) return <MessageResponse streaming>{text}</MessageResponse>;
    return (
      <MessageMenu text={text} {...(onInsert ? { onQuote: onInsert } : {})}>
        <MessageResponse>{text}</MessageResponse>
      </MessageMenu>
    );
  }
  // Forward compatibility: an unrecognised row is still a row. A silently
  // missing one is worse than an unstyled one.
  return <p className="px-1.5 text-xs text-muted-foreground">{itemLabel(item)}</p>;
}
