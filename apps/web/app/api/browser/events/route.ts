import { controlledBrowserRuntime } from "@/lib/server/browser-runtime";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const runtime = controlledBrowserRuntime();
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (version: number) => controller.enqueue(encoder.encode(`data: ${version}\n\n`));
      // BrowserSurface performs one explicit initial read. This stream only
      // reports subsequent mutations, avoiding a duplicate state/screenshot
      // request every time the Browser surface mounts.
      unsubscribe = runtime.subscribe(send);
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      }, { once: true });
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
