"use client";

/**
 * WHAT `/agent` DRAWS — the Agent's conversation, or the reason there is not one
 * (#531).
 *
 * ── IT IS NOT THE COCKPIT, AND THAT IS THE POINT ────────────────────────────
 * `/main` rendered `SessionCockpit` with no `projectId`, and everything Main did
 * not have — a canvas, a checkout, a branch, Run, Open — was absent by
 * construction rather than by a flag. That worked because Main WAS a session.
 *
 * The Agent is not. There is no session id, no journal, no turn record, no
 * workspace and no provider to pick: there is a thread of rows and one model
 * chosen in Settings. `SessionCockpit` cannot be handed any of that, so this
 * screen is its own — the cockpit's MESSAGE COMPONENTS and its COMPOSER reused
 * whole, with nothing between them that a session would have needed.
 *
 * WHAT IS ABSENT HERE IS ABSENT BY CONSTRUCTION TOO, just one level down: there
 * is no project breadcrumb because there is no project, no checkout tabs
 * because there is no checkout, no Run or Open because there is nothing to run,
 * and no model picker because the composer's is gated on a `session` this
 * screen does not pass.
 *
 * ── THE EMPTY STATE IS A SENTENCE, NOT A 404 ────────────────────────────────
 * The address is reserved and always resolves; what varies is whether the Agent
 * is switched on. Off reads as "turn it on in Settings" — a thing the reader can
 * do — where a 404 would read as Telar being broken, which is the failure this
 * address is most likely to be bookmarked into (somebody switches the Agent
 * off, then opens the tab they kept).
 *
 * NO KEY IS A DIFFERENT SENTENCE, said here rather than left for the first turn
 * to fail: the conversation exists, it simply cannot call a model yet, and a
 * person who has just switched this on has no reason to know a key is a
 * separate step.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SparklesIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { hostFromPathname, hostName, LOCAL_HOST_ID } from "@/lib/hosts/client";
import { useAgentThread, type AgentThreadHandle } from "@/lib/agent/thread";
import { AgentTranscript } from "./agent-transcript";
import { AgentApproval } from "./agent-approval";
import { Composer } from "@/components/composer";
import { ContextMeter } from "@/components/context-meter";
import { AgentComposerControls, useAgentModels } from "./agent-composer-controls";
import { Button } from "@/components/ui/button";
import { ConversationContent, ConversationScrollButton, ConversationViewport } from "@/components/ui/conversation";

/** Where the switch, the model and the key live. One spelling, so the empty
 *  state and the key banner cannot point at two different places. */
export const AGENT_SETTINGS_HREF = "/settings";

/**
 * WHAT THIS SCREEN IS, as a value rather than as a render tree.
 *
 * LIFTED OUT so the three decisions it makes — has the engine answered, is the
 * Agent on, is the key usable — can be held by a test rather than reached only
 * by standing up a conversation underneath them.
 *
 * `notice` IS ABSENT WHEN THERE IS NOTHING TO SAY, which covers both a working
 * key and an engine too old to report one. Absent must not be read as "no key":
 * the difference is a quiet screen versus one demanding setup from somebody
 * whose Agent is working fine.
 */
export type AgentView = { kind: "loading" } | { kind: "off" } | { kind: "thread"; notice?: "missing" };

export function agentView(handle: Pick<AgentThreadHandle, "state" | "credential" | "loading">): AgentView {
  // NOTHING IS DECIDED UNTIL THE ENGINE HAS ANSWERED ONCE. The default is off,
  // so answering "off" first would tell somebody whose Agent is on that it is
  // off, for the length of one fetch — and this is the screen they opened
  // precisely to use it.
  if (handle.loading || !handle.state) return { kind: "loading" };
  if (!handle.state.enabled) return { kind: "off" };
  const credential = handle.credential;
  // `undefined` is an engine too old to say, which must not read as "no key".
  const notice = credential !== undefined && credential.source === undefined ? "missing" : undefined;
  return { kind: "thread", ...(notice ? { notice } : {}) };
}

const isLocalHost = (hostId?: string): boolean => !hostId || hostId === LOCAL_HOST_ID;

/**
 * WHOSE SETTINGS TO SEND SOMEBODY TO — and `undefined` when the answer is "not
 * a page this cockpit has".
 *
 * A paired Mac's switch, model and key live on THAT Mac, and this app has no
 * `/hosts/<id>/settings` route: Settings is scoped to the local engine. Composing
 * one would be a 404 dressed as a fix, so a remote Agent gets a SENTENCE naming
 * the Mac instead of a button that fails. If a host-scoped settings route ever
 * exists, this is the one place that has to learn about it.
 */
export function agentSettingsHref(hostId?: string): string | undefined {
  return isLocalHost(hostId) ? AGENT_SETTINGS_HREF : undefined;
}

export function AgentScreen() {
  /**
   * WHICH MAC THIS SCREEN IS ABOUT — the address bar says, exactly as it does
   * for a session on another Mac. `/agent` is this cockpit's own engine;
   * `/hosts/<id>/agent` is that Mac's, and every read below is routed there.
   */
  const hostId = hostFromPathname(usePathname());
  const handle = useAgentThread(hostId);
  const view = agentView(handle);
  const [draft, setDraft] = useState("");

  const { send } = handle;
  const submit = useCallback(() => {
    const text = draft;
    setDraft("");
    void send(text);
  }, [draft, send]);

  /** The composer's pickers. One read per screen, failing soft — an empty
   *  picker carrying the service's reason beats one full of ids that 404. */
  const catalogue = useAgentModels(hostId);
  const { configure: write } = handle;
  const configure = useCallback((patch: { model?: string; effort?: string; access?: string }) => void write(patch), [write]);

  if (view.kind === "loading") return <div className="flex min-h-0 flex-1" aria-busy="true" />;

  if (view.kind === "off") {
    return (
      <AgentEmpty
        hostId={hostId}
        title="The Agent is off"
        body={
          isLocalHost(hostId)
            ? "The Agent is one conversation per Mac for keeping track of Telar work. It has no project and no checkout: it reads the rail, delegates bounded tasks to sessions, and reports back."
            : `The Agent is one per Mac, and this one is ${hostName(hostId) ?? "another Mac"}’s. Its switch, its model and its key are set in Telar’s Settings over there — this cockpit cannot change them.`
        }
        action="Turn it on in Settings"
      />
    );
  }

  const running = handle.state?.running === true;
  const request = handle.state?.request;
  // The LAST ENDED turn's cost, not the live one's: a meter that emptied itself
  // the moment you spoke would answer a question nobody asked.
  const lastUsage = handle.state?.lastUsage;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* THE BANNER SITS ABOVE THE CONVERSATION rather than replacing it: the
          thread and its history are real and worth reading even when the next
          turn would fail. */}
      {view.notice === "missing" && <AgentKeyNotice hostId={hostId} />}
      {handle.error && (
        <p role="status" className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-foreground">
          {handle.error}
        </p>
      )}

      {/* THE CONTEXT METER (#539). This screen has no masthead to hang it on —
          the Agent is not a session, so there is no breadcrumb — so it gets the
          thinnest strip that can hold it, above the conversation and below the
          banners, which is where a masthead's would have sat anyway. It draws
          nothing until a turn has ended, so a fresh thread is not topped with an
          empty gauge. */}
      {lastUsage && (
        <div className="flex shrink-0 justify-end px-4 py-1">
          <ContextMeter
            {...(lastUsage.usage ? { usage: lastUsage.usage } : {})}
            contextChars={lastUsage.contextChars}
            budgetChars={lastUsage.budgetChars}
          />
        </div>
      )}

      <ConversationViewport className="min-h-0 flex-1">
        <ConversationContent className="px-4">
          {handle.items.length === 0 ? (
            <p className="mx-auto max-w-[50rem] py-8 text-sm text-muted-foreground">
              Nothing yet. Ask it what is happening across your sessions, or hand it something to delegate.
            </p>
          ) : (
            <AgentTranscript items={handle.items} />
          )}
          {/* THE OPEN APPROVAL IS LIVE STATE, NOT HISTORY — one card at the
              bottom, off `/api/agent`. A card drawn from the row log would
              resurrect decisions that have already been made. */}
          {request && (
            <div className="mx-auto w-full max-w-[50rem] py-2">
              <AgentApproval request={request} sending={handle.sending} onDecide={(id, decision) => void handle.resolve(id, decision)} />
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </ConversationViewport>

      {/* THE COCKPIT'S OWN COMPOSER, with no session and no project. Its model
          picker, its git strip and its `@`-completion over a repository are all
          gated on those two — so what this screen does not want is gone by
          construction rather than by a flag passed from here. */}
      <Composer
        draft={draft}
        ready
        attachments={[]}
        onAttach={() => {}}
        /* THE AGENT'S OWN THREE PILLS (#539) — same look as the session
           composer's, different sources, because the Agent has no provider
           catalogue, no per-model effort list and no session runtime mode. See
           `agent-composer-controls.tsx`. */
        controls={<AgentComposerControls state={handle.state} models={catalogue.models} {...(catalogue.message ? { message: catalogue.message } : {})} onChange={configure} />}
        busy={running}
        sending={handle.sending}
        backgroundTasks={0}
        onDraftChange={setDraft}
        onSubmit={submit}
        onStop={() => void handle.cancel()}
        onStopBackground={() => {}}
        onRuntimeMode={() => {}}
      />
    </div>
  );
}

export function AgentKeyNotice({ hostId }: { hostId?: string }) {
  const settings = agentSettingsHref(hostId);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs">
      <span className="text-foreground">The Agent has no OpenCode Go key yet, so it cannot answer.</span>
      {/* A LINK ONLY WHERE THERE IS A PAGE — see `agentSettingsHref`. */}
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

function AgentEmpty({ title, body, action, hostId }: { title: string; body: string; action: string; hostId?: string }) {
  const settings = agentSettingsHref(hostId);
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
