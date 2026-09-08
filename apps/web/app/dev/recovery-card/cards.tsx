"use client";

import { RecoveryActions } from "@/components/session-cockpit";
import { continuationDraft } from "@/lib/failed-turn-recovery";

/**
 * THE RECOVERED-TURN CARD, in the states a person actually reaches it in.
 *
 * The unit tests can say that Continue submits nothing and that the draft never
 * contains the original prompt. What they cannot say is the thing the bug was
 * really about: which button a person's eye lands on. The old card led with
 * "Retry as new run" and hid the good path behind "Discard recovered run", so
 * people replayed their prompt and watched the agent redo work. That is a
 * question about hierarchy and wording, and it is answered by looking.
 */
function Case({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{note}</p>
      </div>
      <div className="max-w-2xl rounded-lg border border-dashed p-3">{children}</div>
    </section>
  );
}

export function RecoveryCards() {
  return (
    <div className="flex flex-col gap-8 p-8">
      <header>
        <h1 className="text-lg font-semibold">Recovered turn — the three verbs</h1>
        <p className="text-sm text-muted-foreground">
          Continue is primary and keeps the conversation; re-running is a separate, named risk; discard is last.
        </p>
      </header>

      <Case title="Nothing queued behind it" note="The ordinary case: Telar was quit or lost mid-turn and nothing else was waiting.">
        <RecoveryActions sending={false} backlog={0} onContinue={() => undefined} onRetry={() => undefined} onDiscard={() => undefined} />
      </Case>

      <Case
        title="With a held backlog"
        note="Messages written before the crash are requeued but NOT dispatched — the card says how many, so a waiting session does not read as idle."
      >
        <RecoveryActions sending={false} backlog={2} onContinue={() => undefined} onRetry={() => undefined} onDiscard={() => undefined} />
      </Case>

      <Case title="One held message" note="Singular, because '1 messages are waiting' is the kind of thing that makes a product feel unread.">
        <RecoveryActions sending={false} backlog={1} onContinue={() => undefined} onRetry={() => undefined} onDiscard={() => undefined} />
      </Case>

      <Case title="A decision in flight" note="Every verb disabled while the previous press is still being recorded.">
        <RecoveryActions sending backlog={0} onContinue={() => undefined} onRetry={() => undefined} onDiscard={() => undefined} />
      </Case>

      <Case
        title="What Continue puts in the composer"
        note="Prepared, never sent — and it never contains the original prompt. The second form is what a session with no provider cursor gets, where the agent will remember nothing."
      >
        <div className="flex flex-col gap-3">
          <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{continuationDraft("", { failure: "Telar was restarted" })}</pre>
          <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
            {continuationDraft("", { failure: "Telar was restarted" }, false)}
          </pre>
        </div>
      </Case>
    </div>
  );
}
