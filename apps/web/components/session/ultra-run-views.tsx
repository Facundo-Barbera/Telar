"use client";

// THE THREE ON-DEMAND RUN READERS for the full-pane Ultra tab.
//
// THEY RENDER LIKE THE CHAT DOES, NOT LIKE A LOG FILE. Each of these three used
// to be a raw `<pre>` of 10px monospace: an agent's prose arrived as one
// unwrapped blob with its tool calls thrown away, a result arrived as unlit
// JSON, and a script arrived as unlit JavaScript. All three are the same
// content the main transcript already renders well, so they now go through the
// SAME primitives — `MessageResponse` (Streamdown, whose `code` plugin is the
// app's only syntax highlighter) and `ToolStepGroup` (the collapsed
// "N steps · Bash ×2" affordance). Reusing them is not tidiness: a second
// renderer for agent prose is a second place for it to drift.
//
// THE FENCE IS HOW HIGHLIGHTING HAPPENS. Streamdown highlights a fenced block
// with a language and renders bare fences through `MarkdownPre`'s plain box, so
// a script/result is wrapped in an explicit ```lang fence rather than handed
// over as loose text. Fencing untrusted text needs the guard below — see
// `fenced`.
//
// THE `cancelled` RE-CHECK AFTER EVERY AWAIT is carried across unchanged (the
// rail's NH-2 note). It has no behavioural consequence while each instance is
// keyed by its run, but a file that applies a pattern correctly twice and drops
// it once reads as a decision rather than an omission.

import { useEffect, useState } from "react";
import { MessageResponse, ToolStepGroup } from "@/components/conversation";
import type { ToolPart } from "@/components/session/tool-step";
import { cn } from "@/lib/utils";

/** Wrap `body` in a fence that `body` cannot escape. A run's own script or an
 *  agent's own result can legitimately contain a ``` line — closing the block
 *  early and spilling the remainder into the page as markdown. The fence grows
 *  past the longest backtick run inside, which is CommonMark's own rule for
 *  exactly this. */
function fenced(body: string, lang: string): string {
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

/** The scroll box every reader shares. Height is the caller's business — a rail
 *  and a full pane want different ones — so it arrives as `className`. */
const BOX = "min-w-0 overflow-y-auto overflow-x-hidden rounded-md border bg-background/40 px-3 py-2";

// ── one agent's transcript ──────────────────────────────────────────────────

// `GET /api/ultra/[id]/agents/[ordinal]` → `{ ordinal, events }`, the
// `EngineEvent` stream (session | text | tool | tool-result | result) tagged
// with the retry `attempt` that produced each event.
//
// HIGHEST `attempt` ONLY, for the same reason the index's `lastText` is: a
// retried ordinal's attempt-1 events are DISCARDED WORK — the run took attempt
// 2's answer, and interleaving both is how a transcript starts contradicting
// itself.
//
// THIS IS THE UNCAPPED ROUTE. The agents INDEX route clips each snippet at 200
// code points (`SNIPPET_CAP`), which is right for a one-line row and wrong for
// anything that wants the prose — so a wide pane comes here, never there.
type AgentEvent = {
  attempt?: number;
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  ok?: boolean;
  output?: string;
};

/** Prose and tool runs, in the order they happened. A run of consecutive tool
 *  calls collapses into one group exactly as `groupParts` does for the main
 *  transcript — same shape, so the same `ToolStepGroup` renders it. */
type Block = { kind: "text"; key: string; text: string } | { kind: "tools"; key: string; parts: ToolPart[] };

export function agentBlocks(events: readonly AgentEvent[], ordinal: number): Block[] {
  const top = events.reduce((m, e) => (typeof e.attempt === "number" && e.attempt > m ? e.attempt : m), 0);
  const blocks: Block[] = [];
  events.forEach((e, i) => {
    if (e.attempt !== top) return;
    if (e.type === "text" && typeof e.text === "string" && e.text !== "") {
      blocks.push({ kind: "text", key: `${ordinal}:${i}`, text: e.text });
      return;
    }
    if (e.type === "tool") {
      const part: ToolPart = {
        type: "tool",
        name: typeof e.name === "string" ? e.name : "tool",
        id: `${ordinal}:${i}`,
        ...(e.input && typeof e.input === "object" ? { input: e.input as Record<string, unknown> } : {}),
      };
      const last = blocks[blocks.length - 1];
      if (last?.kind === "tools") last.parts.push(part);
      else blocks.push({ kind: "tools", key: `${ordinal}:${i}`, parts: [part] });
      return;
    }
    if (e.type === "tool-result") {
      // Lands on the tool call it answers — the LAST part of the open group.
      // A result with no open group (a transcript that begins mid-run) is
      // dropped rather than given a synthetic parent it never had.
      const last = blocks[blocks.length - 1];
      if (last?.kind !== "tools") return;
      const part = last.parts[last.parts.length - 1];
      if (!part) return;
      part.output = typeof e.output === "string" ? e.output : "";
      if (e.ok === false) part.isError = true;
    }
    // "session" and "result" are bookkeeping, not transcript.
  });
  return blocks;
}

export function AgentTranscript({
  runId,
  ordinal,
  className,
}: {
  runId: string;
  ordinal: number;
  className?: string;
}) {
  const [events, setEvents] = useState<AgentEvent[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/ultra/${encodeURIComponent(runId)}/agents/${ordinal}`);
        if (!r.ok || cancelled) return;
        const d: unknown = await r.json();
        if (cancelled) return;
        const rows = (d as { events?: unknown }).events;
        setEvents(Array.isArray(rows) ? (rows as AgentEvent[]) : []);
      } catch {
        if (!cancelled) setEvents([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, ordinal]);

  if (events === null) {
    return <div className={cn(BOX, "text-xs text-muted-foreground/60", className)}>Loading transcript…</div>;
  }
  const blocks = agentBlocks(events, ordinal);
  if (blocks.length === 0) {
    return (
      <div className={cn(BOX, "text-xs text-muted-foreground/60", className)}>
        This agent left no transcript.
      </div>
    );
  }
  return (
    <div className={cn(BOX, "flex flex-col gap-2", className)}>
      {blocks.map((b) =>
        b.kind === "text" ? (
          <div key={b.key} className="min-w-0 text-sm">
            <MessageResponse>{b.text}</MessageResponse>
          </div>
        ) : (
          <ToolStepGroup
            key={b.key}
            toolParts={b.parts}
            live={false}
            open={open[b.key] ?? false}
            onToggle={() => setOpen((p) => ({ ...p, [b.key]: !(p[b.key] ?? false) }))}
            rowOpen={(k) => open[`${b.key}:${k}`] ?? false}
            onToggleRow={(k) =>
              setOpen((p) => ({ ...p, [`${b.key}:${k}`]: !(p[`${b.key}:${k}`] ?? false) }))
            }
          />
        ),
      )}
    </div>
  );
}

// ── the run's returned value ────────────────────────────────────────────────

export function Result({ runId, className }: { runId: string; className?: string }) {
  const [body, setBody] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/ultra/${encodeURIComponent(runId)}`);
        if (!r.ok || cancelled) return;
        const d: unknown = await r.json();
        const result = (d as { run?: { result?: unknown } }).run?.result;
        if (cancelled || result === undefined) return;
        // A run whose script returned a plain string is shown AS PROSE, not as
        // a quoted JSON scalar — that is the common case for a synthesis run
        // and `"…\n…"` with escaped newlines is unreadable.
        setBody(typeof result === "string" ? result : fenced(JSON.stringify(result, null, 2), "json"));
      } catch {
        // A `done` run whose manifest cannot be re-read shows nothing rather
        // than an error — the outcome already reached the user through the
        // completion wake (story 4.1).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);
  if (body === null) return null;
  return (
    <div className={cn(BOX, "min-w-0 text-sm", className)}>
      <MessageResponse>{body}</MessageResponse>
    </div>
  );
}

// ── the script ──────────────────────────────────────────────────────────────

// READ-ONLY, and now HIGHLIGHTED — a workflow script is JavaScript, and reading
// one as unlit 10px monospace was the single most common complaint about this
// pane.
//
// NO AUTHORING-REFERENCE TOGGLE. It used to share this box: a button that
// replaced the script with `ULTRA_AUTHORING_REFERENCE`, guidance about how to
// WRITE a script. Nobody inspecting a finished run wants the manual — that
// belongs where a script is authored (the session's own system-prompt appendix,
// which still carries the same string), not where one is read.
export function ScriptTab({ runId, className }: { runId: string; className?: string }) {
  const [script, setScript] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/ultra/${encodeURIComponent(runId)}/script`);
        if (cancelled) return;
        if (!r.ok) {
          setScript("");
          return;
        }
        const d: unknown = await r.json();
        // The SECOND suspension point needs its own re-check, exactly as
        // `AgentTranscript` and `Result` above already do (review NH-2).
        if (cancelled) return;
        const s = (d as { script?: unknown }).script;
        setScript(typeof s === "string" ? s : "");
      } catch {
        if (!cancelled) setScript("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId]);
  if (script === null) {
    return <div className={cn(BOX, "text-xs text-muted-foreground/60", className)}>Loading script…</div>;
  }
  if (script === "") {
    return (
      <div className={cn(BOX, "text-xs text-muted-foreground/60", className)}>
        No script on disk for this run.
      </div>
    );
  }
  return (
    <div className={cn(BOX, "min-w-0 text-sm", className)}>
      <MessageResponse>{fenced(script, "js")}</MessageResponse>
    </div>
  );
}
