"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type PairState = { phase: "idle" } | { phase: "pairing" } | { phase: "paired" } | { phase: "failed"; message: string };

/**
 * A code as a person might paste it: eight digits with or without a space,
 * the long `tlr_…` token, or a whole pairing link with the token in its
 * fragment. Anything else is returned as-is and the server says what is
 * wrong with it.
 */
export function codeFromInput(raw: string): string {
  const trimmed = raw.trim();
  const hash = trimmed.indexOf("#");
  if (hash >= 0) {
    const fromFragment = new URLSearchParams(trimmed.slice(hash + 1)).get("token");
    if (fromFragment) return fromFragment.trim();
  }
  return trimmed;
}

/** Eight digits look like a code the moment they are typed; the field shows
 *  them as "4812 9037" and sends them bare. Anything with letters is left
 *  alone — it is a token or a link, and those are not reformatted. */
export function formatTyped(raw: string): string {
  const digitsOnly = raw.replace(/[\s-]/g, "");
  if (!/^\d{0,8}$/.test(digitsOnly)) return raw;
  return digitsOnly.length > 4 ? `${digitsOnly.slice(0, 4)} ${digitsOnly.slice(4)}` : digitsOnly;
}

/**
 * Reads `#token=…`, STRIPS THE FRAGMENT FIRST (so back-button, screenshots
 * and referrers cannot carry it), exchanges it for a device cookie, and
 * lands on the inbox.
 *
 * AND A WAY IN BY HAND. A link can fail for reasons that have nothing to do
 * with the code — a fragment lost by a chat app, a QR that would not scan,
 * a browser that opened the link without its hash — and before this the
 * page's only answer was "generate a fresh one". The eight-digit code on the
 * Settings card of the machine that minted it is the recovery: type it here
 * and the same exchange runs.
 */
export function PairClient() {
  const router = useRouter();
  const [state, setState] = useState<PairState>({ phase: "pairing" });
  const [typed, setTyped] = useState("");
  const started = useRef(false);

  const pair = async (token: string, announce = true) => {
    if (announce) setState({ phase: "pairing" });
    try {
      const response = await fetch("/api/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        /* NO deviceName. This used to send the literal "Browser", and a
           declared name beats everything the server can work out — so every
           browser row said "Browser" while the cockpit knew perfectly well
           it was Safari on an iPhone. A page cannot introduce itself better
           than the request already does; let the server name it. */
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setState({ phase: "failed", message: body?.error?.message ?? "Pairing failed." });
        return;
      }
      setState({ phase: "paired" });
      router.replace("/");
    } catch {
      setState({ phase: "failed", message: "The cockpit did not answer." });
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    // The fragment dies before the network is touched.
    window.history.replaceState(null, "", window.location.pathname);
    // No synchronous setState here (the lint rule is right that it would
    // cascade a render): the page starts as "pairing", and both branches
    // move it on from a microtask.
    void (async () => {
      if (!token) {
        setState({ phase: "idle" });
        return;
      }
      await pair(token, false);
    })();
    // `pair` closes over the router only; running once on mount is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canType = state.phase === "idle" || state.phase === "failed";
  const code = codeFromInput(typed);
  const looksNumeric = /^[\d\s-]*$/.test(typed);

  return (
    /* `app-ground`: this page's own full-height canvas. Without the opt-in a
       backdrop stopped at its edges — the app went glassy and the pairing
       screen stayed a solid sheet of --background over the scene. */
    <main className="app-ground flex min-h-dvh items-center justify-center bg-background text-foreground">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl border border-border/60 px-10 py-8">
        <div className="text-lg font-medium">Telar</div>
        {state.phase === "pairing" && <p className="text-sm text-muted-foreground">Pairing this browser…</p>}
        {state.phase === "paired" && <p className="text-sm text-muted-foreground">Paired — opening the cockpit.</p>}
        {state.phase === "failed" && <p className="max-w-72 text-center text-sm text-destructive">{state.message}</p>}
        {state.phase === "idle" && (
          <p className="max-w-72 text-center text-sm text-muted-foreground">
            Enter the eight-digit code from Settings → Remote access on the machine running Telar.
          </p>
        )}
        {canType && (
          <form
            className="flex w-full flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (code) void pair(code);
            }}
          >
            <Input
              autoFocus
              value={typed}
              onChange={(event) => setTyped(formatTyped(event.target.value))}
              placeholder="0000 0000"
              aria-label="Pairing code"
              autoComplete="one-time-code"
              inputMode={looksNumeric ? "numeric" : "text"}
              spellCheck={false}
              className={looksNumeric ? "h-12 text-center font-mono text-2xl tracking-[0.25em] tabular-nums" : "font-mono text-xs"}
            />
            <Button type="submit" size="sm" disabled={!code}>
              Pair
            </Button>
            <p className="text-center text-[0.6875rem] text-muted-foreground">A whole pairing link pastes here too.</p>
          </form>
        )}
      </div>
    </main>
  );
}
