"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type PairState = { phase: "pairing" } | { phase: "paired" } | { phase: "failed"; message: string };

/**
 * Reads `#token=…`, STRIPS THE FRAGMENT FIRST (so back-button, screenshots
 * and referrers cannot carry it), exchanges it for a device cookie, and
 * lands on the inbox.
 */
export function PairClient() {
  const router = useRouter();
  const [state, setState] = useState<PairState>({ phase: "pairing" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    // The fragment dies before the network is touched.
    window.history.replaceState(null, "", window.location.pathname);
    void (async () => {
      if (!token) {
        setState({ phase: "failed", message: "This link is missing its pairing code. Generate a fresh one in Settings → Remote access." });
        return;
      }
      try {
        const response = await fetch("/api/pair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, deviceName: "Browser" }),
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
    })();
  }, [router]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-border/60 px-10 py-8">
        <div className="text-lg font-medium">Telar</div>
        {state.phase === "pairing" && <p className="text-sm text-muted-foreground">Pairing this browser…</p>}
        {state.phase === "paired" && <p className="text-sm text-muted-foreground">Paired — opening the cockpit.</p>}
        {state.phase === "failed" && (
          <p className="max-w-72 text-center text-sm text-destructive">{state.message}</p>
        )}
      </div>
    </main>
  );
}
