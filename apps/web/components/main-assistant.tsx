"use client";

/**
 * WHAT `/main` DRAWS — the designated conversation, or the reason there is not
 * one (#526).
 *
 * IT IS THE ORDINARY COCKPIT, with no project. That is the whole of this
 * component's job: resolve which session the engine calls Main, then render
 * `SessionCockpit` without a `projectId`. A second cockpit built for this one
 * screen would drift from the real one on the first fix to either, and the
 * things Main does NOT have — a canvas, a checkout, a branch, Run, Open — are
 * already absent by construction there rather than by a flag passed from here.
 *
 * THE EMPTY STATE IS A SENTENCE, NOT A 404. The address is reserved and always
 * resolves; what varies is whether anything is designated. Off reads as "turn it
 * on in Settings" — a thing the reader can do — where a 404 would read as
 * Telar being broken, which is the failure `/main` is most likely to be
 * bookmarked into (somebody switches Main off, then opens the tab they kept).
 *
 * NO KEY IS A SENTENCE TOO, and it is a different one: the conversation exists,
 * it simply cannot call a model yet. Said here rather than left for the first
 * turn to fail, because a person who has just switched this on has no reason to
 * know a key is a separate step.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SparklesIcon } from "lucide-react";
import { SessionCockpit } from "@/components/session-cockpit";
import { hostFromPathname, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { useMainSession, type MainSessionHandle } from "@/lib/main-session";
import { Button } from "@/components/ui/button";

/**
 * Where the switch, the model and the key live. One spelling, so the empty
 * state and the key banner cannot point at two different places.
 *
 * NO FRAGMENT. This app has no hash-to-row navigation — a settings row's anchor
 * is reached through the pane's own search (`lib/settings-search.ts`) — so a
 * `#main-session` here would be a link that silently landed at the top of the
 * pane and looked like it had failed.
 */
export const MAIN_SETTINGS_HREF = "/settings";

/**
 * WHAT THIS SCREEN IS, as a value rather than as a render tree.
 *
 * LIFTED OUT FOR THE REASON `provider-instances.ts` lifts its status language
 * out: three decisions live here — has the engine answered, is anything
 * designated, and is the key usable — and a decision made inside a render
 * function is one nothing can test without standing up the whole cockpit
 * underneath it.
 *
 * `notice` IS ABSENT WHEN THERE IS NOTHING TO SAY, which covers both a working
 * key and an engine too old to report one. Absent must not be read as "no key":
 * the difference is a quiet screen versus one demanding setup from somebody
 * whose assistant is working fine.
 */
export type MainAssistantView =
  | { kind: "loading" }
  | { kind: "off" }
  | { kind: "session"; sessionId: string; notice?: "missing" | "rejected" };

export function mainAssistantView(handle: Pick<MainSessionHandle, "main" | "credential" | "loading">): MainAssistantView {
  // NOTHING IS DECIDED UNTIL THE ENGINE HAS ANSWERED ONCE. The default is OFF,
  // so answering "off" first would tell somebody whose Main is on that it is
  // off, for the length of one fetch — and this is the screen they opened
  // precisely to use it.
  if (handle.loading) return { kind: "loading" };
  // The id OUTLIVES the switch (disabling keeps it so re-enabling reuses the
  // same conversation), so both halves are asked.
  if (!handle.main.enabled || !handle.main.sessionId) return { kind: "off" };
  const credential = handle.credential;
  const notice = credential === undefined ? undefined : credential.rejected === true ? "rejected" : credential.source === undefined ? "missing" : undefined;
  return { kind: "session", sessionId: handle.main.sessionId, ...(notice ? { notice } : {}) };
}

export function MainAssistant() {
  /**
   * WHICH MAC THIS SCREEN IS ABOUT — the address bar says, exactly as it does
   * for a session on another Mac. `/main` is this cockpit's own engine;
   * `/hosts/<id>/main` is that Mac's, and every read below is routed there.
   */
  const hostId = hostFromPathname(usePathname());
  const view = mainAssistantView(useMainSession(hostId));

  if (view.kind === "loading") return <div className="flex min-h-0 flex-1" aria-busy="true" />;

  if (view.kind === "off") {
    return (
      <MainEmpty
        hostId={hostId}
        title="The Main assistant is off"
        body={
          isLocalHost(hostId)
            ? "Main is one conversation per Mac for keeping track of Telar work and coordinating the other sessions. It has no project and no checkout: it reads the rail, delegates, and reports back."
            : "Main is one conversation per Mac, and this one is another Mac's. Its switch, its model and its key are set in Telar's Settings over there — this cockpit cannot change them."
        }
        action="Turn it on in Settings"
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* THE BANNER SITS ABOVE THE COCKPIT rather than replacing it: the
          conversation and its history are real and worth reading even when the
          next turn would fail. */}
      {view.notice && <MainKeyNotice rejected={view.notice === "rejected"} hostId={hostId} />}
      {/* NO `projectId`. That absence is the whole route: the canvas, the
          breadcrumb link, the checkout tabs, Run and Open are all gone from the
          ordinary cockpit by construction rather than by a flag from here. */}
      <SessionCockpit sessionId={view.sessionId} />
    </div>
  );
}

/**
 * WHOSE SETTINGS TO SEND SOMEBODY TO — and `undefined` when the answer is "not
 * a page this cockpit has".
 *
 * A paired Mac's switch, model and key live on THAT Mac, and this app has no
 * `/hosts/<id>/settings` route: Settings is scoped to the local engine, and
 * there is no remote settings surface to link into. Composing one would be a
 * 404 dressed as a fix, which is strictly worse than the local link it
 * replaced — so a remote Main gets a SENTENCE naming the Mac instead of a
 * button that fails.
 *
 * IF A HOST-SCOPED SETTINGS ROUTE EVER EXISTS, this is the one place that has
 * to learn about it.
 */
export function mainSettingsHref(hostId?: string): string | undefined {
  return isLocalHost(hostId) ? MAIN_SETTINGS_HREF : undefined;
}

const isLocalHost = (hostId?: string): boolean => !hostId || hostId === LOCAL_HOST_ID;

export function MainKeyNotice({ rejected, hostId }: { rejected: boolean; hostId?: string }) {
  const settings = mainSettingsHref(hostId);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs">
      <span className="text-foreground">
        {rejected
          ? "OpenCode Go refused this Mac’s key. The Main assistant cannot answer until it is replaced."
          : "The Main assistant has no OpenCode Go key yet, so it cannot answer."}
      </span>
      {/* A LINK ONLY WHERE THERE IS A PAGE. Another Mac's key is set on that
          Mac, and this cockpit has no route into its Settings — see
          `mainSettingsHref`. */}
      {settings ? (
        <Link href={settings} className="font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Add one in Settings
        </Link>
      ) : (
        <span className="text-muted-foreground">Add one in Telar’s Settings on that Mac.</span>
      )}
    </div>
  );
}

function MainEmpty({ title, body, action, hostId }: { title: string; body: string; action: string; hostId?: string }) {
  const settings = mainSettingsHref(hostId);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-md space-y-3 text-center">
        <SparklesIcon aria-hidden className="mx-auto size-6 text-muted-foreground" />
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
        {settings && <Button render={<Link href={settings} />}>{action}</Button>}
      </div>
    </div>
  );
}
