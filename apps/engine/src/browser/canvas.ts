/**
 * The engine's coordinate tools, translated for the headless runtime.
 *
 * The desktop host takes `browser_click {x, y}` as-is. Playwright MCP does not:
 * with `--caps vision` (see `transport.ts`) it has separate `browser_mouse_*_xy`
 * tools instead. This is the one place that knows the mapping, and the one
 * place that says which canvas tools the headless runtime cannot do at all —
 * typing into whatever has focus (Playwright MCP types only by ref).
 */

export type HeadlessCanvasCall = { name: string; args: Record<string, unknown> } | { refusal: string };

function hasPoint(args: Record<string, unknown>): boolean {
  return typeof args.x === "number" && typeof args.y === "number";
}

function refusal(name: string): { refusal: string } {
  return { refusal: `${name} here needs Telar's desktop browser, which this session cannot reach right now.` };
}

export function headlessCanvasCall(name: string, args: Record<string, unknown>): HeadlessCanvasCall {
  if (name === "browser_click" && hasPoint(args)) {
    return {
      name: "browser_mouse_click_xy",
      args: {
        x: args.x,
        y: args.y,
        ...(args.button !== undefined ? { button: args.button } : {}),
        ...(args.doubleClick === true ? { clickCount: 2 } : {}),
      },
    };
  }
  if (name === "browser_hover" && hasPoint(args)) {
    return { name: "browser_mouse_move_xy", args: { x: args.x, y: args.y } };
  }
  if (name === "browser_drag") {
    return { name: "browser_mouse_drag_xy", args: { startX: args.x, startY: args.y, endX: args.toX, endY: args.toY } };
  }
  if (name === "browser_type" && args.target === undefined) return refusal(name);
  return { name, args };
}
