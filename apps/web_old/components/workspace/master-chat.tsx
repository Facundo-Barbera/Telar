"use client";

// THE MASTER SURFACE (story 5.7, SPEC-organization-workspace CAP-3;
// ui-contract.md §1) — the workspace's front door, and the first project-less
// conversation in the app.
//
// AN OWNER ADAPTER, NOT A SECOND CHAT WINDOW. SPEC.md's constraint is literal:
// "Master chat is born on the shared `Conversation` shell as an owner adapter,
// not a bespoke chat window." So everything below is CONFIGURATION of that
// shell — four slots (items, kinds, composer, rail) and a projection — plus
// the session semantics the shell is forbidden to hold (INV-8a): the fetch, the
// stream, the run id, the permission answers. The reducer those semantics are
// made of lives in @/lib/master-chat, where a bun test can drive it without a
// DOM; this file is the effects around it.
//
// WHY NOT SessionView. That component takes `project: string` as a required
// prop and dereferences it for its right-panel scope, its file autocomplete,
// its git panel and half its URLs. The master has no project — that is the
// whole point of story 5.6's anchor — so reusing it would mean threading a
// fake project through a component that would then act on it. The shell IS the
// shared part, and this adapter is what the shell was carved out for.
//
// EIGHT BUILT-IN KINDS AND NO MORE, IN THIS STORY. The briefing bands, the gap
// card, the witness card and the receipt (ui-contract §1) are stories 9/10's
// items: nothing on the server emits them yet, and a registered kind with no
// producer is a renderer no transcript can reach. What this story owes them is
// the SHELL THEY RENDER INTO — a registry constructed here, at module scope,
// which a later story extends by adding entries to one array. Until then the
// master's briefing and receipt arrive as ordinary assistant text, which is
// what the harness actually produces today.
//
// AND THE HEADER'S BED-MODE CHIP IS DEFERRED TOO — NAMED HERE BECAUSE THE
// REVIEW CAUGHT IT UNNAMED. ui-contract §1 gives this header "a bed-mode
// summary chip when a run happened: window, action count, and `0 started`",
// and the mockup renders one (lib/demo-gallery/workspace/home.tsx's
// `PageHeader actions`). It is NOT ported, and the reason is the same rule
// that keeps the four kinds out: bed mode is story 11, and there is no run to
// report — no runner, no digest, nothing on disk that could say when a window
// opened or how many actions it took. Story 11's own brief is explicit that
// "the `0 started` report is a real invariant to assert against, not display
// copy", so a chip hardcoding a window and a tally would be exactly the
// display copy it forbids, on the surface whose contract is agent honesty.
// What this story ships instead is the slot: `PageHeader` already takes an
// `actions` node, so story 11 adds one conditional chip and nothing else here
// moves. The mockup's `description="Tuesday · 09:14"` is not ported at all and
// never will be — it is a clock, and NFR-OW-11 bans clocks outright.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BUILTIN_KINDS,
  CONVERSATION_KINDS,
  Conversation,
  ConversationEmptyState,
  createItemKindRegistry,
  groupParts,
  PromptInput,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  readPreStreamError,
  Shimmer,
  toTranscriptItems,
  type PromptInputMessage,
  type StoreMessage,
  type TranscriptItem,
  type TurnPayload,
} from "@/components/conversation";
import { PageHeader } from "@/components/common/page-header";
import { WorkspaceTabs } from "@/components/workspace/chips";
import { DeskRail } from "@/components/workspace/desk-rail";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES } from "@/lib/attachment-contract";
import { uploadAttachments } from "@/lib/attachment-upload";
import { consumeSSE } from "@/lib/sse";
import { dispatchTelarRefresh } from "@/lib/telar-refresh";
import {
  applyMasterEvent,
  attachToMasterTurn,
  beginMasterTurn,
  endMasterTurn,
  INITIAL_MASTER_STATE,
  masterTurnPayload,
  resolvePermission,
  seedMasterMessages,
  type MasterChatState,
} from "@/lib/master-chat";

// MODULE SCOPE, BUT STILL A PROP. The registry is built once because building
// it per render would hand the shell a new object every keystroke; it reaches
// the shell through `kinds` because the shell takes it as a prop and never as a
// singleton — two surfaces on one page must not share a registration list.
const MASTER_KINDS = createItemKindRegistry([...BUILTIN_KINDS]);

export type MasterChatProps = {
  /** The account this surface's turns run under. Resolved server-side; the
   *  master has no account picker — it is one long-lived conversation, not a
   *  session the user configures per turn. */
  account: string;
  /** The resumed master chat's model, when there is one to resume. */
  model?: string;
  /** The harness session id to continue, from the persisted master chat. */
  initialSessionId?: string;
  /** The persisted transcript, seeded so a reload does not read as empty. */
  initialMessages?: StoreMessage[];
};

export function MasterChat({
  account,
  model,
  initialSessionId,
  initialMessages,
}: MasterChatProps) {
  const [state, setState] = useState<MasterChatState>(() => ({
    ...INITIAL_MASTER_STATE,
    sessionId: initialSessionId ?? null,
    messages: seedMasterMessages(initialMessages ?? []),
  }));
  // The one-line failure banner above the composer, for the two failures that
  // happen OUTSIDE a turn and therefore have no transcript position to live in:
  // a rejected attachment (over the cap, too many) and a permission answer the
  // server refused. Same idiom as session-view's `attachmentError` — the app has
  // no toast primitive, and a control that silently does nothing is worse.
  const [composerError, setComposerError] = useState<string | null>(null);
  // The turn in flight, for Stop. Client-minted per turn, so Stop works before
  // the harness has named a session (the stop route takes runId first).
  const runIdRef = useRef<string | null>(null);
  // The stream writes `sessionId` into state; the NEXT turn's payload has to
  // read it outside a render, so it is mirrored here.
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  useEffect(() => {
    sessionIdRef.current = state.sessionId;
  }, [state.sessionId]);

  const busy = state.status === "submitted" || state.status === "streaming";

  const respondPermission = useCallback(
    (id: string, behavior: "allow" | "deny", always: boolean, rule?: string) => {
      // Optimistic, then authoritative: the card settles now, and the stream's
      // own `permission_result` frame lands on the same value. THE MOAT IS NOT
      // TOUCHED HERE — this answers a TOOL guardrail prompt, which is a
      // different question from accepting an item, and no path on this surface
      // does the latter on a human's behalf.
      setState((s) => resolvePermission(s, id, behavior === "allow" ? "allowed" : "denied"));
      // AND THE OPTIMISM IS CHECKED. /api/chat/permission answers `{ok:false}`
      // for an answer it could not take (already resolved, timed out, unknown)
      // and 400s a rule it never offered. Left unread, the card would read
      // "Allowed" while the harness sat parked on the prompt — a UI that
      // reports a human decision the server never received, which on the one
      // surface whose job is to put the accept-moat on screen is the failure
      // that matters. So the card goes back to pending and says why.
      void (async () => {
        try {
          const res = await fetch("/api/chat/permission", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, behavior, always, ...(rule ? { rule } : {}) }),
          });
          const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || body?.ok === false) {
            setState((s) => resolvePermission(s, id, "pending"));
            setComposerError(body?.error ?? `The answer was not taken (HTTP ${res.status}).`);
          }
        } catch (err) {
          setState((s) => resolvePermission(s, id, "pending"));
          setComposerError(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [],
  );

  const send = useCallback(
    async (text: string, files: PromptInputMessage["files"] = []) => {
      const message = text.trim();
      if ((!message && files.length === 0) || busy) return;
      const runId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      runIdRef.current = runId;
      setComposerError(null);
      setState((s) =>
        beginMasterTurn(s, {
          userId,
          assistantId: crypto.randomUUID(),
          text: message,
        }),
      );

      let failure: string | null = null;
      try {
        // BYTES FIRST, TURN SECOND — the same order and the same shared
        // uploader a project session uses. "Paste anything" (ui-contract §1) is
        // a promise about the clipboard, and the clipboard carries screenshots:
        // the vendored composer consumes a file paste whether or not a surface
        // wants it, so the only honest options were to carry it or to refuse
        // it, and the route already takes attachments for any session kind.
        // A failed upload throws to the catch below and becomes the turn's
        // error marker, never a turn whose text refers to a file nobody got.
        const attachments = files.length ? await uploadAttachments(files) : [];
        setState((s) => attachToMasterTurn(s, userId, attachments));

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // ROLE MASTER, NO PROJECT — the payload builder is where that is
          // decided and where it is tested. See @/lib/master-chat.
          body: JSON.stringify(
            masterTurnPayload({
              message,
              runId,
              sessionId: sessionIdRef.current,
              account,
              attachments,
              ...(model ? { model } : {}),
            }),
          ),
        });
        if (!res.ok || !res.body) {
          // A pre-stream failure is plain JSON, not an SSE frame — a rejected
          // anchor (the 400 a project-less turn would get if `role` went
          // missing) arrives here and must be readable, not a silent no-op.
          // No `??` fallback: on THIS branch (`!ok || !body`) the helper's only
          // null case (`ok && body`) is already excluded, so a fallback here
          // would be a string no run can produce.
          failure = await readPreStreamError(res);
        } else {
          await consumeSSE(res.body.getReader(), (event, payload) => {
            setState((s) => applyMasterEvent(s, event, payload));
          });
        }
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      } finally {
        runIdRef.current = null;
        setState((s) => endMasterTurn(s, { error: failure }));
        // THE DESK RE-READS, THE SURFACE STILL DOES NOT NOTIFY. A master turn
        // is the one moment the workspace store can have changed under an open
        // rail — the master's tools just wrote it — so the same event every
        // other workspace writer dispatches goes out here. It is a pull the
        // human's own turn asked for, not a push at an absent human.
        //
        // "workspace" AND NOTHING ELSE. A `"chats"` domain used to ride along,
        // and it woke listeners that can never show this conversation: master
        // rows are filtered OUT of /api/chats (`c.role !== "master"`) and out of
        // app-shell-data's recents (which requires a project), so every one of
        // those refetches was a read whose result could not change.
        dispatchTelarRefresh({ domains: ["workspace"] });
      }
    },
    [account, busy, model],
  );

  const stopTurn = useCallback(() => {
    const runId = runIdRef.current;
    const sessionId = sessionIdRef.current;
    // NOTHING TO STOP IS NOT A REQUEST. With both refs null the body would be
    // `{}` — a 400 nobody sees, and an unhandled rejection behind it.
    if (!runId && !sessionId) return;
    void fetch("/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(runId ? { runId } : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    }).catch((err: unknown) => {
      setComposerError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  // THE PROJECTION THE SHELL RENDERS. One `conversation:turn` per message,
  // each carrying its own grouped items — the same two-level shape the project
  // session hands the shell, minus sub-agent buckets, ultra anchors and
  // compaction dividers (none of which a master turn can produce).
  const transcriptItems = useMemo<TranscriptItem[]>(
    () =>
      state.messages.map((m, i) => {
        const isLast = i === state.messages.length - 1;
        return {
          kind: CONVERSATION_KINDS.turn,
          key: m.id,
          payload: {
            from: m.role,
            items: toTranscriptItems(groupParts(m.id, m.parts), {
              onRespond: respondPermission,
            }),
            pending:
              m.role === "assistant" && m.parts.length === 0 && busy && isLast ? (
                <Shimmer className="text-sm">
                  {state.thinking ? "Thinking…" : "Reading…"}
                </Shimmer>
              ) : undefined,
          } satisfies TurnPayload,
        };
      }),
    [busy, respondPermission, state.messages, state.thinking],
  );

  return (
    <div className="flex h-dvh flex-col">
      <Conversation
        items={transcriptItems}
        kinds={MASTER_KINDS}
        live={busy}
        header={<PageHeader leading={<WorkspaceTabs active="chat" />} title="Workspace" />}
        empty={
          <ConversationEmptyState
            title="Nothing said yet"
            description="Ask, dump, or paste anything."
          />
        }
        composer={
          // NO ULTRA CHIP, NO MODEL PICKER, NO PERMISSION-MODE MENU
          // (ui-contract.md §1): ultra's mutating tools dereference a project,
          // which the master lacks, and the other two are session configuration
          // this surface does not offer. What is left is the three modes the
          // contract names — ask, dump, paste — which is one textarea.
          <div className="relative mx-auto w-full max-w-[50rem] px-4 pb-4">
            {composerError && (
              <p className="mb-1.5 px-1 text-[11px] leading-relaxed text-destructive">
                {composerError}
              </p>
            )}
            {/* THE PROVIDER IS WHAT MAKES THE THROW BELOW MEAN ANYTHING, and it
                is why the master is no longer the app's only providerless
                PromptInput. Without one the composer is UNCONTROLLED and the
                vendor's submit handler calls `form.reset()` BEFORE it ever
                awaits onSubmit — so a rejected submit cleared the textarea
                anyway and the human's words were simply gone. With a provider,
                the text lives in context and is cleared only on a resolved
                submit. It also owns the staged attachments, which is the other
                half of "paste anything". */}
            <PromptInputProvider>
              <PromptInput
                maxFiles={ATTACHMENT_MAX_FILES}
                maxFileSize={ATTACHMENT_MAX_BYTES.image}
                onError={(err) =>
                  setComposerError(
                    err.code === "max_files"
                      ? `At most ${ATTACHMENT_MAX_FILES} attachments per message.`
                      : err.code === "max_file_size"
                        ? `Attachments are capped at ${ATTACHMENT_MAX_BYTES.image / 1024 / 1024} MB.`
                        : err.message,
                  )
                }
                onSubmit={async (msg) => {
                  // THROWING IS HOW THE WORDS SURVIVE. PromptInput clears its
                  // composer only when this handler RESOLVES, and Enter still
                  // reaches it mid-turn: while a turn streams the submit control
                  // is a Stop button, so the vendor's `button[type="submit"]
                  // disabled` guard finds nothing to check and submits anyway. A
                  // silent early return in `send` would therefore erase what the
                  // human just typed. Rejecting keeps it in the box — which is
                  // true here BECAUSE of the provider wrapped around this
                  // composer, and was not true without it.
                  if ((!msg.text.trim() && !msg.files.length) || busy) throw new Error("not sent");
                  await send(msg.text, msg.files);
                }}
              >
                <PromptInputBody>
                  {/* A pasted or dropped file is CHIPPED, then sent. The
                      vendored textarea swallows a file paste unconditionally
                      (preventDefault + attachments.add), so a surface that
                      rendered no chips would consume the screenshot and show
                      nothing — the one outcome worse than either carrying it or
                      refusing it. */}
                  <PromptInputAttachments />
                  <PromptInputTextarea
                    className="min-h-10"
                    placeholder="Ask, dump everything, or paste anything…"
                  />
                </PromptInputBody>
                <PromptInputFooter>
                  {/* The surface states its own contract, in the footer, in
                      words — ui-contract.md §1's last line. */}
                  <span className="text-[10px] text-muted-foreground/60">
                    pull-based — this surface never notifies you; it answers when you arrive
                  </span>
                  <PromptInputSubmit
                    className="ml-auto shrink-0 self-end"
                    status={state.status === "ready" ? undefined : state.status}
                    onStop={stopTurn}
                  />
                </PromptInputFooter>
              </PromptInput>
            </PromptInputProvider>
          </div>
        }
        rail={<DeskRail />}
      />
    </div>
  );
}
