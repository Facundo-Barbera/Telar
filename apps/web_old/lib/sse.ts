// Shared SSE frame reader — the one parser for the app's `event: \ndata: \n\n`
// wire format (chat turns AND the dock's live tail alike). Client-safe: no
// server-only imports. Extracted from session-view.tsx so a second surface
// consuming the same stream (the dock) never reimplements this framing.

/**
 * Reads an SSE stream frame-by-frame: accumulate decoded chunks, split on the
 * blank-line record separator, parse each record's `event:`/`data:` lines,
 * and hand (event, payload) to `onEvent`. Resolves when the reader is
 * exhausted (the server closes the stream).
 */
export async function consumeSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: string, payload: any) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      let event = "";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      onEvent(event, payload);
    }
  }
}
