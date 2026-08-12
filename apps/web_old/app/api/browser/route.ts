import type { ControlledBrowserAction } from "@/lib/browser-runtime-contract";
import { controlledBrowserRuntime } from "@/lib/server/browser-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const scopeKey = searchParams.get("scopeKey")?.trim();
  if (!scopeKey) return Response.json({ error: "scopeKey is required." }, { status: 400 });
  return Response.json(await controlledBrowserRuntime().state(scopeKey));
}

export async function POST(request: Request) {
  const body = await request.json() as ControlledBrowserAction & { scopeKey?: string };
  const scopeKey = body.scopeKey?.trim();
  if (!scopeKey) return Response.json({ error: "scopeKey is required." }, { status: 400 });
  const runtime = controlledBrowserRuntime();
  try {
    switch (body.action) {
      case "navigate":
        await runtime.call("browser_navigate", { url: body.url }, { notify: false, scopeKey });
        break;
      case "back":
        await runtime.call("browser_navigate_back", {}, { notify: false, scopeKey });
        break;
      case "forward":
        await runtime.call("browser_press_key", { key: "Alt+ArrowRight" }, { notify: false, scopeKey });
        break;
      case "reload":
        await runtime.call("browser_press_key", { key: "ControlOrMeta+R" }, { notify: false, scopeKey });
        break;
      case "new":
        await runtime.call("browser_tabs", { action: "new", ...(body.url ? { url: body.url } : {}) }, { notify: false, scopeKey });
        break;
      case "select":
        await runtime.call("browser_tabs", { action: "select", index: body.index }, { notify: false, scopeKey });
        break;
      case "close":
        await runtime.call("browser_tabs", { action: "close", ...(body.index === undefined ? {} : { index: body.index }) }, { notify: false, scopeKey });
        break;
      default:
        return Response.json({ error: "Unknown browser action." }, { status: 400 });
    }
    return Response.json(await runtime.state(scopeKey));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
