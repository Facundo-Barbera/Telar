import type { ControlledBrowserState } from "@/lib/browser-runtime-contract";
import type { BrowserToolResult } from "@/lib/server/browser-runtime";
import { desktopBrowserHost } from "@/lib/server/desktop-browser-host";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const hostId = new URL(request.url).searchParams.get("hostId")?.trim();
  if (!hostId) return Response.json({ error: "hostId is required." }, { status: 400 });
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (command: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(command)}\n\n`));
      };
      unsubscribe = desktopBrowserHost().subscribeCommands(hostId, send);
      heartbeat = setInterval(() => {
        desktopBrowserHost().touch(hostId);
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* closed */ }
      }, 15_000);
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      }, { once: true });
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
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

export async function POST(request: Request) {
  const body = await request.json() as {
    kind?: "register" | "state" | "respond" | "disconnect";
    hostId?: string;
    state?: ControlledBrowserState;
    id?: string;
    result?: BrowserToolResult;
    error?: string;
  };
  const hostId = body.hostId?.trim();
  if (!hostId) return Response.json({ error: "hostId is required." }, { status: 400 });
  const broker = desktopBrowserHost();
  switch (body.kind) {
    case "register":
      if (!body.state) return Response.json({ error: "state is required." }, { status: 400 });
      broker.register(hostId, body.state);
      break;
    case "state":
      if (!body.state) return Response.json({ error: "state is required." }, { status: 400 });
      broker.updateState(hostId, body.state);
      break;
    case "respond":
      if (!body.id) return Response.json({ error: "id is required." }, { status: 400 });
      broker.respond(hostId, body.id, body.result, body.error);
      break;
    case "disconnect":
      broker.disconnect(hostId);
      break;
    default:
      return Response.json({ error: "Unknown desktop browser host message." }, { status: 400 });
  }
  return Response.json({ ok: true });
}
