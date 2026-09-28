"use client";

import { useRef, useState, type DragEvent, type RefObject } from "react";
import { readReferenceDrag, REFERENCE_MIME } from "@/lib/drag-reference";
import type { ComposerEditorHandle } from "../components/composer-editor";

const accepts = (event: DragEvent) =>
  event.dataTransfer.types.includes(REFERENCE_MIME) || event.dataTransfer.types.includes("Files") || event.dataTransfer.types.includes("text/uri-list");

/** Files become attachments; a panel reference or any other text is inserted at the caret. */
export function useDropTarget(editor: RefObject<ComposerEditorHandle | null>, addFiles: (files: File[]) => void) {
  // dragenter/dragleave fire for every child crossed, so a depth count rather than a boolean.
  const depth = useRef(0);
  const [dropping, setDropping] = useState<false | "reference" | "content">(false);

  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!accepts(event)) return;
      depth.current += 1;
      setDropping(event.dataTransfer.types.includes(REFERENCE_MIME) ? "reference" : "content");
    },
    onDragOver: (event: DragEvent) => {
      if (!accepts(event)) return;
      // Without both, the browser refuses the drop and animates the item back.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDropping(false);
    },
    onDrop: (event: DragEvent) => {
      depth.current = 0;
      setDropping(false);
      const files = [...event.dataTransfer.files];
      if (files.length > 0) {
        event.preventDefault();
        addFiles(files);
        return;
      }
      const reference = readReferenceDrag(event.dataTransfer);
      const text = reference?.text ?? event.dataTransfer.getData("text/uri-list") ?? "";
      const plain = text || event.dataTransfer.getData("text/plain");
      if (!plain) return;
      event.preventDefault();
      editor.current?.insertAtCaret(plain);
    },
  };

  return { dropping, handlers };
}
