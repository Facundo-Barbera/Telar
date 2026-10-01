/** Largest item handed to xterm at once: its parser yields only between items. */
export const ITEM_CHARS = 16_384;
/** Past this much queued output, write now instead of waiting for a frame a hidden window may never paint. */
const QUEUE_CHARS = 1_000_000;

export type FrameWriter = { push: (data: string) => void; flush: () => void; cancel: () => void };

/** Coalesces output into one write per animation frame, cut into items of at most `ITEM_CHARS`. */
export function frameWriter(write: (data: string) => void): FrameWriter {
  let queued: string[] = [];
  let size = 0;
  let frame: number | null = null;
  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const chunks = queued;
    queued = [];
    size = 0;
    let item = "";
    for (const chunk of chunks) {
      if (item !== "" && item.length + chunk.length > ITEM_CHARS) {
        write(item);
        item = "";
      }
      item += chunk;
    }
    if (item !== "") write(item);
  };
  return {
    push: (data) => {
      if (data === "") return;
      queued.push(data);
      size += data.length;
      if (size > QUEUE_CHARS) return flush();
      frame ??= requestAnimationFrame(() => {
        frame = null;
        flush();
      });
    },
    flush,
    cancel: () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      queued = [];
      size = 0;
    },
  };
}
