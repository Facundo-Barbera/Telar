"use client";

import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { OpenerIcon } from "./opener-icon";
import { fileReference, type TelarReference } from "@/lib/drag-reference";
import type { WorkspaceFileMenu } from "../workspace-open";

/** One menu for the address row and the body; the textarea keeps the browser's own edit menu. */
export function FileMenuItems({
  path,
  absolute,
  files,
  onReread,
  wrap,
  onWrap,
  markdown,
  source,
  onSource,
  onInsertReference,
  onOpenInNewPanelTab,
}: {
  path: string;
  absolute?: string | undefined;
  files: WorkspaceFileMenu;
  onReread: () => void;
  wrap?: { on: boolean } | undefined;
  onWrap: (on: boolean) => void;
  markdown: boolean;
  source: boolean;
  onSource: (source: boolean) => void;
  onInsertReference?: ((reference: TelarReference) => void) | undefined;
  onOpenInNewPanelTab?: ((path: string) => void) | undefined;
}) {
  return (
    <>
      {onOpenInNewPanelTab && (
        <>
          <ContextMenuItem onClick={() => onOpenInNewPanelTab(path)}>Open in a new panel tab</ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {absolute && <ContextMenuItem onClick={() => void navigator.clipboard?.writeText(absolute)}>Copy path</ContextMenuItem>}
      <ContextMenuItem onClick={() => void navigator.clipboard?.writeText(path)}>Copy relative path</ContextMenuItem>
      {files.reveal && files.open && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => files.reveal!(path, "file")}>Reveal in Finder</ContextMenuItem>
          <ContextMenuItem onClick={() => files.open!(path, "file")}>
            <OpenerIcon icon={files.openIcon} iconDataUrl={files.openIconDataUrl} />
            {files.openLabel}
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onReread}>Re-read from disk</ContextMenuItem>
      {wrap && (
        <ContextMenuCheckboxItem checked={wrap.on} onCheckedChange={onWrap}>
          Wrap lines
        </ContextMenuCheckboxItem>
      )}
      {markdown && (
        <ContextMenuRadioGroup value={source ? "source" : "rendered"} onValueChange={(value) => onSource(value === "source")}>
          <ContextMenuRadioItem value="rendered">Rendered</ContextMenuRadioItem>
          <ContextMenuRadioItem value="source">Source</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
      )}
      {onInsertReference && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onInsertReference(fileReference(path))}>Insert into composer as a reference</ContextMenuItem>
        </>
      )}
    </>
  );
}
