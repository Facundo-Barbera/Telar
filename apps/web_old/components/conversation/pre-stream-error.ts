// ONE reader for a pre-SSE error body, shared rather than copied.
//
// THE SHAPE IT ANSWERS. `POST /api/chat` either opens an SSE stream or rejects
// the turn BEFORE the stream exists, with a plain JSON `{ error: string }` and a
// 4xx. A caller that guards its drain with `if (res.ok && res.body)` and has no
// `else` never reads that body: nothing throws, no catch fires, and the user's
// typed message simply disappears. That was live in the dock
// (session-runtime-host.tsx's sendTurn) and is what this helper closes.
//
// WHY IT NEVER THROWS. It is called on the failure path, where a second failure
// has nowhere to go — a rethrow here would replace one silent loss with a
// different silent loss. Every branch returns a string a human can read:
//   · ok AND a body               → null (there is a stream; nothing to surface)
//   · ok with NO body             → a status-bearing line saying no stream came
//   · body parses as {error: "…"} → that sentence, the server's own words
//   · anything else               → a status-bearing line, never undefined
// A body that rejects on `.json()` (already consumed, truncated, disconnected)
// lands in the last branch like any other unparseable body.
//
// WHY THE SUCCESS TEST IS `ok && body` AND NOT `ok`. It has to match the guard
// it backstops exactly. The dock drains on `if (res.ok && res.body)` and hands
// EVERYTHING ELSE here, so a narrower test here leaves a gap between the two:
// a 200 carrying a null body would be drained by neither and explained by
// neither, and the user's typed message would disappear with no error — the
// precise swallow this helper exists to close, surviving on a narrow path. Two
// guards on one decision must read the same value (story 3.1's maxim 3).
//
// WHY IT IS A PURE FUNCTION OF A `Response`. It fetches nothing and resolves no
// URL — the caller hands it a response it already has. That is what makes it
// testable with a hand-built `new Response(…)` in a repo with no DOM harness and
// no test server, and it is why this file passes INV-8a's "no data fetching"
// scan despite being the one file here that touches a `Response` at all.
//
// SECOND CALLER, DELIBERATELY LATER: session-view.tsx's `send` already does this
// correctly inline. Retrofitting it was NOT done in story 3.1 — `send` is in
// that story's "stayed" set and its AC6 is a behaviour-unchanged claim, so the
// swap belongs to whoever next has `send` open for another reason. One caller of
// a shared helper is still a shared helper.

export async function readPreStreamError(res: Response): Promise<string | null> {
  if (res.ok && res.body) return null;
  const status = `HTTP ${res.status}`;
  if (res.ok) return `${status} — the turn was accepted but no stream arrived.`;
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error === "string" && error.trim()) return error;
  } catch {
    /* not JSON, or the body could not be read — keep the status line */
  }
  return status;
}
