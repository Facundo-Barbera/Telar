import { useState, type DragEvent } from "react";
import { PANEL_TAB_MIME } from "../tabs";
import type { PanelTabItem } from "../model";

type Insert = { id: string; side: "before" | "after" };

/** Reordering the strip by drag. Held by the strip, because a drop lands on a different tab than the one carried. */
export function useTabDrag(tabs: readonly PanelTabItem[], onMoveTab?: (id: string, toIndex: number) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [insert, setInsert] = useState<Insert | null>(null);

  const handlers = (id: string) => ({
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData(PANEL_TAB_MIME, id);
      event.dataTransfer.effectAllowed = "move";
      setDragging(id);
    },
    onDragEnd: () => {
      setDragging(null);
      setInsert(null);
    },
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(PANEL_TAB_MIME) || dragging === id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = event.currentTarget.getBoundingClientRect();
      const side: Insert["side"] = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
      setInsert((current) => (current?.id === id && current.side === side ? current : { id, side }));
    },
    onDragLeave: () => setInsert((current) => (current?.id === id ? null : current)),
    onDrop: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(PANEL_TAB_MIME)) return;
      event.preventDefault();
      const dragged = event.dataTransfer.getData(PANEL_TAB_MIME) || dragging;
      const side = insert?.id === id ? insert.side : "after";
      setDragging(null);
      setInsert(null);
      if (!dragged || dragged === id || !tabs.some((other) => other.id === dragged)) return;
      // `movePanelTab` takes the index in the strip without the carried tab.
      const rest = tabs.filter((other) => other.id !== dragged);
      onMoveTab?.(dragged, rest.findIndex((other) => other.id === id) + (side === "after" ? 1 : 0));
    },
  });

  return { dragging, insert, handlers };
}
