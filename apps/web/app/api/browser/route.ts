import type { ControlledBrowserAction } from "@/lib/browser-runtime-contract";
import { controlledBrowserRuntime } from "@/lib/server/browser-runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await controlledBrowserRuntime().state());
}

export async function POST(request: Request) {
  const body = await request.json() as ControlledBrowserAction;
  const runtime = controlledBrowserRuntime();
  try {
    switch (body.action) {
      case "navigate":
        await runtime.call("browser_navigate", { url: body.url }, { notify: false });
        break;
      case "back":
        await runtime.call("browser_navigate_back", {}, { notify: false });
        break;
      case "forward":
        await runtime.call("browser_press_key", { key: "Alt+ArrowRight" }, { notify: false });
        break;
      case "reload":
        await runtime.call("browser_press_key", { key: "ControlOrMeta+R" }, { notify: false });
        break;
      case "new":
        await runtime.call("browser_tabs", { action: "new", ...(body.url ? { url: body.url } : {}) }, { notify: false });
        break;
      case "select":
        await runtime.call("browser_tabs", { action: "select", index: body.index }, { notify: false });
        break;
      case "close":
        await runtime.call("browser_tabs", { action: "close", ...(body.index === undefined ? {} : { index: body.index }) }, { notify: false });
        break;
      default:
        return Response.json({ error: "Unknown browser action." }, { status: 400 });
    }
    return Response.json(await runtime.state());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
