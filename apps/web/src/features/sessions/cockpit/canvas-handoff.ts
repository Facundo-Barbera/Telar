import { canvasPanelKey, clearPanelTabs, editorInstanceKey, writePanelTabs, type PanelTab, type PanelTabState } from "@/features/panel";
import { clearEditor, writeEditor, type EditorState } from "@/features/files";

/** Carries the canvas's panel strip and Editor files to a session created from it. Only the browser draft clears the canvas behind it. */
export function handOffCanvas(
  target: string,
  projectId: string,
  { panel, editors }: { panel: PanelTabState<PanelTab>; editors: Record<string, EditorState> },
  { clearCanvas }: { clearCanvas: boolean },
) {
  writePanelTabs(target, panel, Date.now());
  for (const [instance, state] of Object.entries(editors)) writeEditor(editorInstanceKey(target, instance), state, Date.now());
  if (!clearCanvas) return;
  clearPanelTabs(canvasPanelKey(projectId));
  for (const instance of Object.keys(editors)) clearEditor(editorInstanceKey(canvasPanelKey(projectId), instance));
  clearEditor(canvasPanelKey(projectId));
}
