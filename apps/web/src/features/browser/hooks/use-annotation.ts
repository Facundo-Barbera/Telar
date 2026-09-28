import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { addMark, annotationTextBlock, boxFromDrag, captureFileName, elementAt, emptyAnnotation, undoMark, type Annotation, type AnnotationTool, type ElementBox, type Mark, type Point } from "../annotation";
import type { AnnotateCapture } from "../components/annotate-overlay";
import { paintMarks } from "../components/annotate-marks";
import { useHostSize } from "./use-browser-viewport";

function fitFrame(frame: { width: number; height: number }, host: { width: number; height: number }) {
  const scale = Math.min(1, host.width / frame.width, host.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  return { scale, width, height, x: (host.width - width) / 2, y: (host.height - height) / 2 };
}

/** Marks are stored in the frame's own pixels; the frame is fitted into the host, never scaled up. */
export function useAnnotation(hostRef: RefObject<HTMLDivElement | null>, capture: AnnotateCapture, onCancel: () => void, onSend: (result: { file: File; text: string }) => void | Promise<void>) {
  const [tool, setTool] = useState<AnnotationTool>("rect");
  const [annotation, setAnnotation] = useState<Annotation>(emptyAnnotation);
  const [drag, setDrag] = useState<{ from: Point; to: Point; points: Point[] } | null>(null);
  const [hover, setHover] = useState<ElementBox | null>(null);
  const [label, setLabel] = useState<{ at: Point; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string>();
  const hostSize = useHostSize(hostRef);

  const frame = useMemo(
    () => fitFrame({ width: capture.width, height: capture.height }, hostSize ?? { width: capture.width, height: capture.height }),
    [capture.width, capture.height, hostSize],
  );

  const pointOf = useCallback(
    (event: React.PointerEvent | React.MouseEvent): Point => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      return { x: Math.round((event.clientX - rect.left) / (frame.scale || 1)), y: Math.round((event.clientY - rect.top) / (frame.scale || 1)) };
    },
    [frame.scale],
  );

  // Escape leaves one layer at a time: an open label first. ⌘Z belongs to the label while it is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (label) setLabel(null);
        else onCancel();
      }
      if (!label && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setAnnotation(undoMark);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [label, onCancel]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (label || sending) return;
    const point = pointOf(event);
    if (tool === "pick") {
      const element = elementAt(capture.elements, point);
      if (element) setAnnotation((current) => addMark(current, { kind: "pick", element }));
      return;
    }
    if (tool === "text") {
      setLabel({ at: point, text: "" });
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({ from: point, to: point, points: [point] });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const point = pointOf(event);
    if (drag) {
      setDrag((current) => (current ? { ...current, to: point, points: [...current.points, point] } : current));
      return;
    }
    if (tool === "pick") setHover(elementAt(capture.elements, point) ?? null);
  };

  const onPointerUp = () => {
    if (!drag) return;
    const { from, to, points } = drag;
    setDrag(null);
    setAnnotation((current) =>
      addMark(current, tool === "arrow" ? { kind: "arrow", from, to } : tool === "freehand" ? { kind: "freehand", points } : { kind: "rect", box: boxFromDrag(from, to) }),
    );
  };

  const drawn: Mark[] = useMemo(() => {
    const marks = [...annotation.marks];
    if (drag) {
      if (tool === "arrow") marks.push({ kind: "arrow", id: "drag", from: drag.from, to: drag.to });
      else if (tool === "freehand") marks.push({ kind: "freehand", id: "drag", points: drag.points });
      else marks.push({ kind: "rect", id: "drag", box: boxFromDrag(drag.from, drag.to) });
    }
    return marks;
  }, [annotation.marks, drag, tool]);

  // A capture the browser cannot decode is reported rather than sent as a blank picture.
  const send = async () => {
    setSending(true);
    setFailed(undefined);
    try {
      const image = new Image();
      image.src = capture.dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = capture.width;
      canvas.height = capture.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This view cannot render the annotated picture.");
      context.drawImage(image, 0, 0, capture.width, capture.height);
      paintMarks(context, annotation.marks);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("The annotated picture could not be encoded.");
      const file = new File([blob], captureFileName(capture.url, "annotated"), { type: "image/png" });
      await onSend({ file, text: annotationTextBlock(capture, annotation) });
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "The annotated picture could not be sent.");
      setSending(false);
    }
  };

  const commitLabel = (at: Point, text: string) => {
    setAnnotation((current) => addMark(current, { kind: "text", at, text }));
    setLabel(null);
  };

  return { tool, setTool, annotation, setAnnotation, hover, setHover, label, setLabel, commitLabel, sending, failed, setFailed, frame, drawn, onPointerDown, onPointerMove, onPointerUp, send };
}
