import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  accountHealth,
  getAccount,
  loginCommand,
  providerOf,
  spawnProviderLogin,
  type LoginSession,
} from "@telar/core";

export const dynamic = "force-dynamic";

// One in-flight login per account, shared across GET (start/stream) and POST
// (submit the pasted code) within this single dev/server process. The child is
// killed on client disconnect (stream cancel / request abort), on a hard
// timeout inside the driver, and whenever a new login for the same account
// starts.
const sessions = new Map<string, LoginSession>();

function drop(name: string, reason: string) {
  const s = sessions.get(name);
  if (s) {
    s.cancel(reason);
    sessions.delete(name);
  }
}

// GET streams the login as Server-Sent Events. The app DRIVES the provider CLI
// (see @telar/core/login): codex self-completes; claude waits for a pasted code
// delivered via POST below. Refuses when the account is already healthy.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const account = getAccount(name);
  if (!account) return Response.json({ error: `Unknown account "${name}".` }, { status: 404 });

  if (accountHealth(account).status === "ok") {
    return Response.json({ error: "Account is already logged in." }, { status: 409 });
  }

  drop(name, "superseded by a new login"); // never run two at once for one account
  const session = spawnProviderLogin(account);
  sessions.set(name, session);

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt: unknown) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
      // Kill the child the moment the client goes away.
      req.signal.addEventListener("abort", () => drop(name, "client disconnected"));
      try {
        for await (const evt of session.events) send(evt);
      } catch (e) {
        send({ type: "failed", error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (sessions.get(name) === session) sessions.delete(name);
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      drop(name, "client disconnected");
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

// POST carries either the pasted authorization code (claude), or a request to
// hand off to Terminal.app (the escape hatch when driving fails). No provider
// hard-requires a TTY today, so `terminal` is a fallback, never the default.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const account = getAccount(name);
  if (!account) return Response.json({ error: `Unknown account "${name}".` }, { status: 404 });
  const body = await req.json().catch(() => ({}));

  if (body.terminal === true) {
    return openInTerminal(account);
  }

  if (typeof body.code === "string" && body.code.trim()) {
    const session = sessions.get(name);
    if (!session) return Response.json({ error: "No login in progress." }, { status: 409 });
    session.submitCode(body.code);
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Expected { code } or { terminal: true }." }, { status: 400 });
}

// DELETE cancels an in-flight login (the UI's Cancel button).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  drop(name, "cancelled by user");
  return Response.json({ ok: true });
}

// macOS Terminal.app hand-off: still one click, no copy-paste, and honest about
// what runs. Uses the provider's native login (browser auto-open) rather than
// the piped device/paste flags, since a real TTY makes those unnecessary.
function openInTerminal(account: Parameters<typeof accountHealth>[0]): Response {
  const provider = providerOf(account.provider);
  const { cmd } = loginCommand(account);
  const cfg = account.configDir
    ? account.configDir.startsWith("~")
      ? path.join(os.homedir(), account.configDir.slice(1))
      : account.configDir
    : undefined;
  const prefix = cfg ? `${provider.configDirEnv}="${cfg}" ` : "";
  const full = `${prefix}${cmd} ${provider.loginArgs.join(" ")}`;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "Terminal"\nactivate\ndo script "${esc(full)}"\nend tell`;
  try {
    const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
    child.unref();
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return Response.json({ ok: true, command: full });
}
