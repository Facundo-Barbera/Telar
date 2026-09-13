"use client";

/**
 * THE TRAY — the room's middle column, summoned and never resident.
 *
 * ── WHAT IT REPLACES, AND WHY THE SHAPE CHANGED ──────────────────────────────
 * The Spool wore the cockpit's right panel: a resident tab strip (Desk, Night,
 * Memory, Queue) that accumulated packet tabs beside it. The stance made half
 * of that redundant — Desk and Queue are bands now — and the strip itself was
 * the wrong grammar for what remained: tabs say "these things are always here",
 * and the room's claim is the opposite. Detail is something you SUMMON — a
 * stance line opens its packet, the night line opens the record, a subject's
 * permit chip opens the grants — and dismiss back to two columns.
 *
 * So: ONE face at a time, no tab strip, no accumulation, a visible close. The
 * faces are the existing folds rendered whole — `packet-body`'s sections, the
 * night surface, the memory surface, the permit grants — none re-spelled.
 *
 * ── THE PACKET FACE CARRIES THE PAGE'S WHOLE CAPABILITY ─────────────────────
 * `/spool/[id]` survives as a deep link that lands here, so everything the
 * page could do must survive here or it silently died with the route: the
 * born-as quote, the proposed approach, the attachment tally, sub-tasks with
 * the human-only promote dialog, the ripening timeline with the expert
 * control, the desk drain, and the handoff. The one-column layout is the only
 * change.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRightIcon, FileTextIcon, InboxIcon, LayoutTemplateIcon, Maximize2Icon, MessageSquareIcon, PlusIcon, XIcon } from "lucide-react";
import type {
  Project,
  SpoolArea,
  SpoolBriefing,
  SpoolItem,
  SpoolItemDetail,
  SpoolLane,
  SpoolLookOutcome,
  SpoolMap,
  SpoolNote,
  SpoolSnapshot,
  SpoolSubject,
  SpoolSubjectPermits,
} from "@telar/engine-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CloseCheckbox, DeadlineChip, ProjectChip, SubjectDot } from "@/components/spool/chips";
import { DEADLINE_KIND_ITEMS, laneItems, laneLabel } from "@/components/spool/lanes";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SUBJECT_COLORS, subjectColorVar } from "@/components/spool/subject-color";
import { ConfirmDialog } from "@/components/spool/dialogs";
import { AskOneThing } from "@/components/spool/prompt-card";
import { MemorySurface } from "@/components/spool/memory-surface";
import { NightSurface } from "@/components/spool/night-surface";
import { PermitsChip } from "@/components/spool/permits";
import {
  BornAs,
  ExpertControl,
  ProposedApproach,
  RipeningTimeline,
  SectionLabel,
} from "@/components/spool/packet-body";
import { closeItemByHand, reopenItemByHand } from "@/lib/spool-close";
import { writeDraft } from "@/lib/composer-draft";
import type { SpoolWorkView } from "@/lib/spool-work";
import { cn } from "@/lib/utils";

/** What the tray is showing. One value, because the tray holds one face —
 *  summoning a second replaces the first rather than growing a strip.
 *  `subject` with `key: null` is the unfiled pseudo-subject: floating is a
 *  rendering of absence, never a stored value, and the face keeps that true by
 *  addressing it as the absence it is. */
export type TrayFace =
  | { kind: "packet"; id: string }
  | { kind: "night" }
  | { kind: "memory" }
  | { kind: "permits" }
  | { kind: "subject"; key: string | null }
  /** The shelf's faces (loops §10.1): a note being read or edited, and a
   *  fresh one being written — subjectless is the ordinary floating case. */
  | { kind: "note"; id: string }
  | { kind: "note-new"; subjectKey?: string };

export function faceTitle(face: TrayFace): string {
  if (face.kind === "subject") return face.key ?? "Unfiled";
  if (face.kind === "note") return "Note";
  if (face.kind === "note-new") return "New note";
  return { packet: "Packet", night: "Night", memory: "Memory", permits: "Permits" }[face.kind];
}

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
  return data;
}

/**
 * "Its turn came" — the single-packet handoff, unchanged in meaning from the
 * retired page: one path, a session, because there are no looms in this app,
 * and nothing runs until a human clicks.
 *
 * THE BRIEFING IS THE ENGINE'S NOW — loops §2's briefed arrival. This used to
 * compose the opening text client-side from the packet's own fields, which
 * meant the delta since the user's last look could never be in it: the web
 * had the packet, the engine had the look. `GET /briefing` composes both
 * deterministically — no model call, no session created — and this fetches it
 * ON THE CLICK, writes it into the composer's draft, and navigates. The text
 * is visible and editable before a single token is spent: nothing is spent
 * until the human sends.
 */
function ItsTurnCame({ detail, projects }: { detail: SpoolItemDetail; projects: Project[] }) {
  const router = useRouter();
  const [fetching, setFetching] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const { item } = detail;

  // A packet's `project` is a free-form label; a session needs a registered id.
  // Matched on the NAME first — that is what a human would have typed into the
  // packet — then on the id, for a caller that already knew it. The engine's
  // briefing re-resolves this and its answer wins at click time; this local
  // read only decides whether the button can honestly offer to try.
  const project = useMemo(
    () => projects.find((p) => p.name === item.project) ?? projects.find((p) => p.id === item.project),
    [projects, item.project],
  );

  const startSession = useCallback(() => {
    setFetching(true);
    setBlocked(null);
    void (async () => {
      try {
        const res = await fetch(`/api/spool/items/${encodeURIComponent(item.id)}/briefing`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { briefing } = (await res.json()) as { briefing: SpoolBriefing };
        // `project` absent is the engine's ordinary answer for a subject with
        // no registered checkout — rendered, never papered over.
        if (!briefing.project) {
          setBlocked(`No registered project matches “${item.project ?? briefing.subject ?? "this packet"}”.`);
          return;
        }
        writeDraft(undefined, briefing.project.id, briefing.briefing);
        router.push(`/projects/${encodeURIComponent(briefing.project.id)}/sessions/new`);
      } catch (err) {
        setBlocked(err instanceof Error ? err.message : String(err));
      } finally {
        setFetching(false);
      }
    })();
  }, [item.id, item.project, router]);

  const sessionBlocked = !item.project
    ? "This packet is floating — file it to a project first, and a session can open there."
    : !project
      ? `No registered project matches “${item.project}”. Register it, or rename the packet's project to match one.`
      : undefined;

  return (
    <section className="space-y-2">
      <SectionLabel>Its turn came</SectionLabel>
      <Button className="w-full" disabled={!!sessionBlocked || fetching} title={sessionBlocked} onClick={startSession}>
        <MessageSquareIcon />
        Start a session
      </Button>
      {blocked && <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{blocked}</p>}
      <p className="pt-1 text-center text-[0.625rem] leading-relaxed text-muted-foreground/60">
        everything above was prepared by agents —
        <br />
        nothing runs until you click
      </p>
    </section>
  );
}

/**
 * THE PACKET'S HAND VERBS — §9.4, the parity rule: "every verb the chat has,
 * the hand gets as a visible control." The chat could always open a question
 * on a subject's map and mark a thread waiting on someone; these are the same
 * two verbs as quiet controls on the packet itself. NO TURN IS SUBMITTED —
 * both write the map directly through the human routes, the same ink the
 * chat's tools write, and a refusal is the engine's sentence rendered in
 * place.
 *
 * "Mark waiting" resolves honestly: when an open thread already holds this
 * capture, the waiting arm PATCHes it; when none does, the waiting rides an
 * `open` — one write — whose question is the USER'S OWN typed words (their
 * note, or "waiting on <who>"), never a sentence a model composed.
 */
function PacketHandVerbs({
  item,
  map,
  onChanged,
}: {
  item: SpoolItem;
  map: SpoolMap | null;
  onChanged: () => void;
}) {
  const subject = item.project;
  const [mode, setMode] = useState<null | "ask" | "waiting">(null);
  const [question, setQuestion] = useState("");
  const [who, setWho] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);

  /** The open thread already holding this capture, when one exists — read
   *  from the room's snapshot, never fetched here. */
  const held = subject
    ? map?.subjects
        .find((s) => s.subject === subject)
        ?.threads.find((v) => !v.thread.settled && v.items.some((i) => i.id === item.id))
    : undefined;

  const run = (job: () => Promise<unknown>, after: string) => {
    setBusy(true);
    setRefused(null);
    void job()
      .then(() => {
        setLanded(after);
        setMode(null);
        setQuestion("");
        setWho("");
        setNote("");
        onChanged();
      })
      .catch((err) => setRefused(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const ask = () => {
    const q = question.trim();
    if (!subject || !q || busy) return;
    run(
      () => send(`/api/spool/threads/${encodeURIComponent(subject)}/open`, "POST", { question: q, items: [item.id] }),
      "The question is on the map — open, unsettled, yours to answer or park.",
    );
  };

  const markWaiting = () => {
    const name = who.trim();
    if (!subject || !name || busy) return;
    const waiting = { kind: "person" as const, who: name, ...(note.trim() ? { note: note.trim() } : {}) };
    if (held) {
      run(
        () =>
          send(
            `/api/spool/threads/${encodeURIComponent(subject)}/${encodeURIComponent(held.thread.id)}`,
            "PATCH",
            { waiting },
          ),
        `Parked on ${name} — it moves to “Waiting on others”.`,
      );
    } else {
      run(
        () =>
          send(`/api/spool/threads/${encodeURIComponent(subject)}/open`, "POST", {
            question: note.trim() || `waiting on ${name}`,
            items: [item.id],
            waiting,
          }),
        `Parked on ${name} — it moves to “Waiting on others”.`,
      );
    }
  };

  return (
    <section>
      <SectionLabel>Questions, by hand</SectionLabel>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={!subject || busy}
          title={subject ? "Open a question on this subject's map" : "A question lives on a subject's map — file this packet to a subject first"}
          onClick={() => setMode((m) => (m === "ask" ? null : "ask"))}
        >
          Ask a question about this
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!subject || busy}
          title={subject ? "Who is this stuck on?" : "A question lives on a subject's map — file this packet to a subject first"}
          onClick={() => setMode((m) => (m === "waiting" ? null : "waiting"))}
        >
          Mark waiting on someone
        </Button>
      </div>
      {mode === "ask" && (
        <div className="mt-2 flex items-center gap-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") ask();
            }}
            placeholder="The question, in your own words…"
            aria-label="The question, in your own words"
            autoFocus
            className="h-8 text-xs md:text-xs"
          />
          <Button variant="outline" size="sm" disabled={busy || !question.trim()} onClick={ask}>
            Open
          </Button>
        </div>
      )}
      {mode === "waiting" && (
        <div className="mt-2 space-y-2">
          <Input
            value={who}
            onChange={(e) => setWho(e.target.value)}
            placeholder="Who is this waiting on?"
            aria-label="Who is this waiting on"
            autoFocus
            className="h-8 text-xs md:text-xs"
          />
          <div className="flex items-center gap-2">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") markWaiting();
              }}
              placeholder="For what? (optional, your words)"
              aria-label="What it is waiting for"
              className="h-8 text-xs md:text-xs"
            />
            <Button variant="outline" size="sm" disabled={busy || !who.trim()} onClick={markWaiting}>
              Mark
            </Button>
          </div>
        </div>
      )}
      {refused && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{refused}</p>}
      {landed && !refused && mode === null && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{landed}</p>
      )}
      <p className="mt-1.5 text-[0.625rem] leading-relaxed text-muted-foreground/60">
        The chat&rsquo;s own two verbs, as hand controls — they write the map directly and submit no turn.
      </p>
    </section>
  );
}

function PacketFace({
  id,
  work,
  lanes,
  subjectKeys,
  map,
  onChanged,
}: {
  id: string;
  work: SpoolWorkView;
  /** The lanes from the room's one snapshot read — the Filing section's
   *  select, never fetched here. */
  lanes: SpoolLane[];
  /** The subject keys that exist, for the datalist. Free text stays legal —
   *  a new subject is a word you are allowed to say. */
  subjectKeys: string[];
  /** The threads map from the room's one snapshot read — the hand verbs
   *  below need to know whether an open thread already holds this capture,
   *  and fetching it here would be a second cadence for one record. */
  map: SpoolMap | null;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<SpoolItemDetail | null | undefined>(undefined);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newSubtask, setNewSubtask] = useState("");
  /** Which sub-task the promote dialog is asking about, if any. */
  const [promoting, setPromoting] = useState<{ id: string; title: string } | null>(null);
  /** The deadline kind the NEXT label commit will carry, while the item has no
   *  deadline yet to read one from. Once one exists, the stored kind leads. */
  const [deadlineKindDraft, setDeadlineKindDraft] = useState<"external" | "self">("self");
  /** §9.2's one quiet sentence — what the close's cascade settled, quoted
   *  from the engine's counts and refusal reasons. Null for a quiet close. */
  const [closeNote, setCloseNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/spool/items/${encodeURIComponent(id)}`);
      if (res.status === 404) return setDetail(null);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    // Deferred to a task rather than called in the effect body — a synchronous
    // fetch-and-setState on mount is a cascading render, and this app lints it.
    const first = window.setTimeout(() => {
      void load();
      void fetch("/api/projects")
        .then((r) => (r.ok ? r.json() : { projects: [] }))
        .then((d) => setProjects(d.projects ?? []))
        .catch(() => setProjects([]));
    }, 0);
    return () => window.clearTimeout(first);
  }, [load]);

  const mutate = useCallback(
    async (job: () => Promise<unknown>) => {
      setBusy(true);
      setWriteError(null);
      try {
        await job();
        await load();
        onChanged();
        return true;
      } catch (err) {
        setWriteError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged],
  );

  const addSubtask = useCallback(() => {
    const title = newSubtask.trim();
    if (!title) return;
    void mutate(async () => {
      await send(`/api/spool/items/${id}/subtasks`, "POST", { title });
      setNewSubtask("");
    });
  }, [id, mutate, newSubtask]);

  /**
   * FILING BY HAND — the workbench principle on the packet itself: lane,
   * subject, deadline and pin are the item's FILING, moved through the same
   * human PATCH surface the chat's tools use, with zero model involvement.
   * The raw fragment is untouchable by construction — `raw` is not in the
   * store's patchable set, and nothing here names it. A refusal is the
   * engine's sentence, rendered as the quiet inline line under the controls.
   */
  const [filingRefused, setFilingRefused] = useState<string | null>(null);
  const file = useCallback(
    (patch: Record<string, unknown>) => {
      void (async () => {
        try {
          await send(`/api/spool/items/${encodeURIComponent(id)}`, "PATCH", patch);
          setFilingRefused(null);
          await load();
          onChanged();
        } catch (err) {
          setFilingRefused(err instanceof Error ? err.message : String(err));
        }
      })();
    },
    [id, load, onChanged],
  );

  /**
   * THE CHECKBOX ON THE PACKET FACE — §9.1. One click, the shared helper's
   * DEDICATED close/reopen POST, no dialog: the packet's own header is still
   * a row the hand closes. The reload repaints the header ticked with the
   * store's quoted label, and the cascade's sentence (if any) sits under it.
   */
  const toggleClosed = useCallback(() => {
    const closing = !detail?.item.closed;
    void (closing ? closeItemByHand(id) : reopenItemByHand(id).then(() => null))
      .then(async (sentence) => {
        setCloseNote(sentence ?? null);
        await load();
        onChanged();
      })
      .catch((err) => setCloseNote(err instanceof Error ? err.message : String(err)));
  }, [detail, id, load, onChanged]);

  if (detail === undefined && !error) {
    return <p className="p-3 text-xs text-muted-foreground/60">Reading…</p>;
  }
  if (detail === null) {
    return (
      <p className="p-3 text-xs leading-relaxed text-muted-foreground/60">
        This item isn&rsquo;t in the spool. Nothing here deletes an item, so it has not been removed — the id may be
        wrong.
      </p>
    );
  }
  if (!detail) {
    return (
      <div className="p-3">
        <Alert variant="destructive">
          <AlertTitle>Couldn&rsquo;t load this packet</AlertTitle>
          <AlertDescription className="font-mono text-xs break-words">{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const { item } = detail;
  const subtasks = item.subtasks ?? [];

  return (
    <div className="space-y-5 p-3">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Refresh failed</AlertTitle>
          <AlertDescription className="font-mono text-xs break-words">{error}</AlertDescription>
        </Alert>
      )}
      {writeError && (
        <Alert variant="destructive">
          <AlertTitle>That change did not land</AlertTitle>
          <AlertDescription className="text-xs break-words">{writeError}</AlertDescription>
        </Alert>
      )}

      <div>
        <div className="flex items-start gap-2">
          <CloseCheckbox
            closed={!!item.closed}
            label={item.closed ? `Reopen “${item.title}”` : `Close “${item.title}”`}
            onToggle={toggleClosed}
            className="mt-0.5"
          />
          <p className={cn("min-w-0 flex-1 text-sm font-medium", item.closed ? "text-muted-foreground/60" : "text-foreground")}>
            {item.title}
          </p>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <ProjectChip name={item.project} mirrored={item.mirrored} />
          {item.deadline && <DeadlineChip deadline={item.deadline} />}
          <span className="font-mono text-[0.625rem] text-muted-foreground/60">
            {detail.lane ? `filed in ${detail.lane} · rank ${detail.rank}` : "not filed in any lane"}
          </span>
          {/* The store's own label, QUOTED — never a time this code minted. */}
          {item.closed && (
            <span className="font-mono text-[0.625rem] text-muted-foreground/60">“closed {item.closed.label}”</span>
          )}
        </div>
        {closeNote && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{closeNote}</p>}
      </div>

      {/* ── FILING, BY HAND ─────────────────────────────────────────────────
             Quiet controls over the item's PLACEMENT — lane, subject, deadline,
             pin — each one a single PATCH through the human API the moment the
             hand states it. What cannot move from here is deliberate: the raw
             fragment is not patchable at all, and subject/deadline can be
             restated but not blanked — the store spells absence as a missing
             key, and only the pin's clear (`pinned: null`) has a verb for it. */}
      <section>
        <SectionLabel>Filing</SectionLabel>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[0.6875rem] text-muted-foreground">Lane</span>
            {/* `items` so the trigger reads the lane's NAME rather than its
                stored key — see `lanes.ts` (#352). */}
            <Select
              value={detail.lane ?? ""}
              items={laneItems(lanes)}
              onValueChange={(next) => {
                if (next && next !== detail.lane) file({ lane: next });
              }}
            >
              <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs" aria-label="Move to a lane">
                <SelectValue placeholder="not filed in any lane" />
              </SelectTrigger>
              <SelectContent>
                {lanes.map((l) => (
                  <SelectItem key={l.key} value={l.key}>
                    {laneLabel(l)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[0.6875rem] text-muted-foreground">Subject</span>
            {/* Keyed on the stored value so a landed PATCH re-seeds it with the
                store's own word — the area input's idiom. Blank leaves the
                filing as it is; there is no clear verb on this field. */}
            <Input
              key={item.project ?? ""}
              defaultValue={item.project ?? ""}
              list="packet-subject-options"
              placeholder="floating — an existing subject, or a new word"
              aria-label="Move to a subject"
              className="h-7 min-w-0 flex-1 text-xs md:text-xs"
              onBlur={(event) => {
                const next = event.currentTarget.value.trim();
                if (next && next !== (item.project ?? "")) file({ project: next });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  const next = event.currentTarget.value.trim();
                  if (next && next !== (item.project ?? "")) file({ project: next });
                }
              }}
            />
            <datalist id="packet-subject-options">
              {subjectKeys.map((key) => (
                <option key={key} value={key} />
              ))}
            </datalist>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[0.6875rem] text-muted-foreground">Deadline</span>
            {/* Your own words — the chip's label, never a date this code
                parses. Committing a label writes the whole deadline with the
                kind beside it. */}
            <Input
              key={item.deadline?.label ?? ""}
              defaultValue={item.deadline?.label ?? ""}
              placeholder="“Friday”, “end of month”…"
              aria-label="Deadline, in your own words"
              className="h-7 min-w-0 flex-1 text-xs md:text-xs"
              onBlur={(event) => {
                const label = event.currentTarget.value.trim();
                if (label && label !== item.deadline?.label) {
                  file({ deadline: { label, kind: item.deadline?.kind ?? deadlineKindDraft } });
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  const label = event.currentTarget.value.trim();
                  if (label && label !== item.deadline?.label) {
                    file({ deadline: { label, kind: item.deadline?.kind ?? deadlineKindDraft } });
                  }
                }
              }}
            />
            <Select
              value={item.deadline?.kind ?? deadlineKindDraft}
              items={DEADLINE_KIND_ITEMS}
              onValueChange={(next) => {
                const kind = next === "external" ? "external" : "self";
                setDeadlineKindDraft(kind);
                if (item.deadline && kind !== item.deadline.kind) {
                  file({ deadline: { label: item.deadline.label, kind } });
                }
              }}
            >
              <SelectTrigger size="sm" className="h-7 w-24 shrink-0 text-xs" aria-label="Whose deadline">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="self">mine</SelectItem>
                <SelectItem value="external">external</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[0.6875rem] text-muted-foreground">Pin</span>
            {/* Picking a day IS stating it — the calendar's own boundary.
                Clearing the field unpins (`pinned: null`); the item stays. */}
            <input
              type="date"
              value={item.pinned?.day ?? ""}
              aria-label="Pin to a day"
              title="Clearing the day unpins — the item stays"
              onChange={(event) => {
                const day = event.currentTarget.value;
                file(day ? { pinned: { day } } : { pinned: null });
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
        {filingRefused && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{filingRefused}</p>}
        <p className="mt-1.5 text-[0.625rem] leading-relaxed text-muted-foreground/60">
          Filing only — the words this was born as stay verbatim, and nothing here submits a turn.
        </p>
      </section>

      <BornAs item={item} dense />
      <ProposedApproach item={item} />

      {/* §9.4 — the chat's question and waiting verbs, as hand controls. */}
      <PacketHandVerbs item={item} map={map} onChanged={onChanged} />

      {(detail.tally.files > 0 || detail.tally.mockups > 0) && (
        <section>
          <SectionLabel>Gathered along the way</SectionLabel>
          <div className="flex items-center gap-4 rounded-xl bg-card p-3 text-xs text-muted-foreground shadow-1 ring-1 ring-foreground/10">
            <span className="flex items-center gap-1.5">
              <FileTextIcon className="size-3.5 shrink-0" />
              <span className="font-mono tabular-nums">{detail.tally.files}</span> file
              {detail.tally.files === 1 ? "" : "s"}
            </span>
            <span className="flex items-center gap-1.5">
              <LayoutTemplateIcon className="size-3.5 shrink-0" />
              <span className="font-mono tabular-nums">{detail.tally.mockups}</span> mockup
              {detail.tally.mockups === 1 ? "" : "s"}
            </span>
          </div>
        </section>
      )}

      <section>
        <SectionLabel>Sub-tasks</SectionLabel>
        <p className="mb-2 text-[0.6875rem] text-muted-foreground/60">
          Breakdown lives inside this item — it never grows the queue count.
        </p>
        <div className="space-y-1.5">
          {subtasks.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-2 rounded-lg border border-border/70 bg-card px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/40"
            >
              <input
                type="checkbox"
                checked={!!s.done}
                disabled={busy}
                onChange={(e) =>
                  void mutate(() => send(`/api/spool/items/${id}/subtasks/${s.id}`, "PATCH", { done: e.target.checked }))
                }
                className="size-3.5 shrink-0 rounded-sm border-border accent-primary"
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  s.done ? "text-muted-foreground/60 line-through" : "text-foreground",
                )}
              >
                {s.title}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => setPromoting({ id: s.id, title: s.title })}
                className="shrink-0 text-[0.625rem] text-muted-foreground/70 underline decoration-dotted transition-colors hover:text-foreground"
              >
                promote
              </button>
            </div>
          ))}
          {subtasks.length === 0 && <p className="text-xs text-muted-foreground/60">No sub-tasks yet.</p>}
          <div className="flex items-center gap-2 pt-1">
            <Input
              value={newSubtask}
              onChange={(e) => setNewSubtask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addSubtask();
              }}
              placeholder="Break off a sub-task…"
              aria-label="Break off a sub-task"
              className="h-8 text-xs md:text-xs"
            />
            <Button variant="outline" size="sm" disabled={busy || !newSubtask.trim()} onClick={addSubtask}>
              <PlusIcon />
              Add
            </Button>
          </div>
        </div>
      </section>

      <section>
        <SectionLabel>Ripening</SectionLabel>
        <RipeningTimeline item={item} />
        {/* THE ONE THING HERE THAT SPENDS MONEY, and it sits at the END of the
            ripening history because that is what it extends. */}
        <div className="mt-2">
          <ExpertControl item={item} work={work} onDone={() => void load()} disabled={busy} />
        </div>
      </section>

      {/* THE DRAIN VERB SURVIVES THE DESK SURFACE. The module has no delete
          path; taking a card off the desk is the one dismissal, and it stays
          in the queue — said where the action is, as the law requires. */}
      {item.desk && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-muted-foreground"
          disabled={busy}
          title="Take it off the desk — it stays in the queue"
          onClick={() => void mutate(() => send(`/api/spool/items/${id}`, "PATCH", { desk: false }))}
        >
          <InboxIcon />
          Drain to the queue — it stays in the queue
        </Button>
      )}

      <ItsTurnCame detail={detail} projects={projects} />

      <ConfirmDialog
        open={!!promoting}
        onOpenChange={(next) => !next && setPromoting(null)}
        title="Promote this sub-task?"
        body={
          <>
            “{promoting?.title}” becomes an item of its own and leaves this packet. Nothing is deleted, and this is the
            only place in Telar where the queue&rsquo;s count grows from breaking work down.
          </>
        }
        confirmLabel="Promote"
        busy={busy}
        onConfirm={() => {
          const target = promoting;
          if (!target) return;
          void mutate(() => send(`/api/spool/items/${id}/subtasks/${target.id}/promote`, "POST")).then(
            (ok) => ok && setPromoting(null),
          );
        }}
      />
    </div>
  );
}

/**
 * A NOTE ON THE SHELF — loops §10.1: knowledge that is not work stops wearing
 * task clothing. One face reads and edits (`id` set) or writes fresh (`id`
 * null); markdown stays a plain textarea because the body is the user's own
 * verbatim text, never rendered prose this face re-interprets.
 *
 * PROVENANCE IS WORN, NOT EDITABLE: a note an agent wrote says so — "agent's
 * note" — and the author never changes on edit; the engine refuses a patch
 * that names it. RETIRING DRAINS, NEVER DELETES: the note leaves the working
 * shelf and stays on the record with the reason, which is REQUIRED — here,
 * in the proxy and in the store — because withdrawing knowledge silently is
 * how a shelf stops being trustworthy. A retired note refuses edits (the
 * engine's rule; the controls disable to say so up front) and renders
 * dimmed with its reason, still legible.
 */
function NoteFace({
  id,
  subjectKey,
  onOpenNote,
  onChanged,
}: {
  /** Null is the fresh-note face — nothing to read yet. */
  id: string | null;
  /** The subject a fresh note files under; absent is floating, the ordinary
   *  cross-subject case. */
  subjectKey?: string | undefined;
  /** A landed create swaps the face to the minted note — same summoning verb
   *  as everything else in the tray. */
  onOpenNote: (id: string) => void;
  onChanged: () => void;
}) {
  const [note, setNote] = useState<SpoolNote | null | undefined>(id ? undefined : null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  /** Comma-separated in the input; split only on save. */
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [retiring, setRetiring] = useState(false);
  const [retireReason, setRetireReason] = useState("");
  const [retireError, setRetireError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/spool/notes/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fresh = (await res.json()).note as SpoolNote;
      setNote(fresh);
      setTitle(fresh.title);
      setBody(fresh.body);
      setTags(fresh.tags.join(", "));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  const retired = !!note?.retired;
  const parsedTags = () =>
    tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

  const save = () => {
    if (busy || retired || !title.trim() || !body.trim()) return;
    setBusy(true);
    setRefused(null);
    void (async () => {
      try {
        if (id) {
          await send(`/api/spool/notes/${encodeURIComponent(id)}`, "PATCH", {
            title: title.trim(),
            body,
            tags: parsedTags(),
          });
          await load();
        } else {
          const created = await send("/api/spool/notes", "POST", {
            title: title.trim(),
            body,
            tags: parsedTags(),
            ...(subjectKey ? { subjectKey } : {}),
          });
          onOpenNote((created.note as SpoolNote).id);
        }
        onChanged();
      } catch (err) {
        setRefused(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  const retire = () => {
    if (!id || busy) return;
    const reason = retireReason.trim();
    if (!reason) {
      // The same law three layers deep — said here before the wire refuses.
      setRetireError("a reason is required — retiring records why the knowledge stopped mattering.");
      return;
    }
    setBusy(true);
    setRetireError(null);
    void send(`/api/spool/notes/${encodeURIComponent(id)}/retire`, "POST", { reason })
      .then(async () => {
        setRetiring(false);
        setRetireReason("");
        await load();
        onChanged();
      })
      .catch((err) => setRetireError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  if (id && note === undefined && !error) {
    return <p className="p-3 text-xs text-muted-foreground/60">Reading…</p>;
  }

  return (
    <div className="space-y-3 p-3">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn&rsquo;t load this note</AlertTitle>
          <AlertDescription className="font-mono text-xs break-words">{error}</AlertDescription>
        </Alert>
      )}
      {/* Drained, still legible — the reason quoted beside the store's own label. */}
      {note?.retired && (
        <p className="text-xs leading-relaxed text-muted-foreground/60">
          retired {note.retired.label} — “{note.retired.reason}”. It stays on the shelf&rsquo;s record; nothing is
          deleted, and a retired note refuses edits.
        </p>
      )}
      {/* Whose hand wrote it — permanent, never editable. */}
      {note?.author === "session" && (
        <p className="font-mono text-[0.625rem] text-muted-foreground/60">agent&rsquo;s note — written by a session, when asked</p>
      )}
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        aria-label="Note title"
        disabled={retired}
        className={cn("h-8 text-xs font-medium md:text-xs", retired && "text-muted-foreground/60")}
      />
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="The note, as markdown — kept verbatim."
        aria-label="Note body, markdown"
        disabled={retired}
        className={cn("min-h-48 font-mono text-xs", retired && "text-muted-foreground/60")}
      />
      <Input
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        placeholder="tags, separated by commas"
        aria-label="Note tags"
        disabled={retired}
        className="h-8 font-mono text-[0.6875rem] md:text-[0.6875rem]"
      />
      {refused && <p className="text-xs leading-relaxed text-muted-foreground">{refused}</p>}
      {!retired && (
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" disabled={busy || !title.trim() || !body.trim()} onClick={save}>
            {id ? "Save" : "Put it on the shelf"}
          </Button>
          {id && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-muted-foreground"
              onClick={() => {
                setRetireError(null);
                setRetiring(true);
              }}
            >
              Retire…
            </Button>
          )}
        </div>
      )}
      <ConfirmDialog
        open={retiring}
        onOpenChange={(next) => !next && setRetiring(false)}
        title="Retire this note?"
        body={
          <>
            “{note?.title}” drains off the working shelf and stays on the record with your reason — nothing is
            deleted, and nothing here can delete. The reason is required.
            <Input
              value={retireReason}
              onChange={(e) => setRetireReason(e.target.value)}
              placeholder="Why it stopped mattering…"
              aria-label="Why this note is being retired"
              className="mt-2 text-xs md:text-xs"
            />
          </>
        }
        confirmLabel="Retire"
        busy={busy}
        error={retireError}
        onConfirm={retire}
      />
    </div>
  );
}

/**
 * ONE SUBJECT'S FILED ITEMS — the queue's inventory reborn as a summoned
 * detail, which is exactly the survival §13.3 grants it: "the inventory view
 * survives only as detail". Every line leads with the user's own words where
 * the packet holds them, carries the lane and the deadline chip the queue's
 * grammar promises render identically everywhere, and opens the packet face.
 * `keyOf(null)` is the unfiled pseudo-subject, reached from the filing fold.
 */
export function SubjectFace({
  subjectKey,
  record,
  areas,
  onOpenItem,
  onOpenNote,
  onNewNote,
  onChanged,
}: {
  subjectKey: string | null;
  /** The subject's own record — identity, terrain, permits — passed down
   *  from the room's one snapshot read, never fetched here. A PATCH below
   *  round-trips through `onChanged`, so the fresh record flows back in. */
  record: SpoolSubject | undefined;
  /** Every area that exists across the records — the datalist, so stating an
   *  area offers the user's own existing words while free text stays legal. */
  areas: string[];
  onOpenItem: (id: string) => void;
  /** The shelf's two doors from this face — open a note, or start one filed
   *  to this subject. */
  onOpenNote: (id: string) => void;
  onNewNote: (subjectKey?: string) => void;
  onChanged: () => void;
}) {
  const [view, setView] = useState<SpoolSnapshot | null>(null);
  /** THE SHELF — this subject's notes (loops §10.1), retired ones included
   *  and marked: a list that hid them would make retirement look like
   *  deletion. The unfiled face shows the floating notes, same absence rule
   *  as its items. */
  const [notes, setNotes] = useState<SpoolNote[]>([]);
  /** The subject's STORED look — where it lives and when the Spool last saw
   *  it. A read of the record, `fresh: false`, no network on the engine side. */
  const [look, setLook] = useState<SpoolLookOutcome | null>(null);
  /** The done fold — closed by default; it is a record, not an arrival
   *  question. Unticking a row there is the reopen, instant, no dialog. */
  const [doneOpen, setDoneOpen] = useState(false);
  const [reopenRefused, setReopenRefused] = useState<string | null>(null);
  /** The shelf row's own DOM node per note, keyed by id — the anchor the
   *  retire ask positions against, and which note (if any) has it open. */
  const noteRowRefs = useRef<Map<string, HTMLElement>>(new Map());
  /** THE ROW THE RETIRE PROMPT HANGS OFF, CAPTURED AT THE CLICK. The prompt
   *  used to read `noteRowRefs.current.get(note.id)` inline in the row it was
   *  rendered beside — a ref read during render, which React cannot schedule
   *  around: the map is filled by ref callbacks that run at commit, so the
   *  first render after a mount reads a miss and the dialog opens unanchored,
   *  with nothing to make it try again. Reading the map in the CLICK handler
   *  instead is both correct and simpler — by then the row is on screen. */
  const [retiringNote, setRetiringNote] = useState<{ id: string; anchor: HTMLElement | null } | null>(null);
  const retiringNoteId = retiringNote?.id ?? null;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/spool");
      if (res.ok) setView((await res.json()) as SpoolSnapshot);
      if (subjectKey) {
        const lookRes = await fetch(`/api/spool/looks/${encodeURIComponent(subjectKey)}`);
        if (lookRes.ok) setLook(((await lookRes.json()).look ?? null) as SpoolLookOutcome | null);
      }
      const notesRes = await fetch(`/api/spool/notes${subjectKey ? `?subject=${encodeURIComponent(subjectKey)}` : ""}`);
      if (notesRes.ok) {
        const all = ((await notesRes.json()).notes ?? []) as SpoolNote[];
        // The unfiled face's slice is the floating notes — subjectless is a
        // rendering of absence here exactly as it is for items.
        setNotes(subjectKey ? all : all.filter((n) => !n.subjectKey));
      }
    } catch {
      // A dropped read leaves the last good list. The face is pull-based.
    }
  }, [subjectKey]);

  /**
   * THE ROW'S OWN "Retire…" — the SAME `POST /api/spool/notes/:id/retire`
   * route `NoteFace`'s own `retire()` (below, ~line 915) hits; that function
   * itself is private to a face already open on this one note, so the list
   * row (which has not opened a face) reaches the identical route directly
   * rather than duplicating it as a second endpoint. §7's "the reason is a
   * fact the store keeps" still holds — an anchored `AskOneThing` gathers it
   * by hand now (§ the idiom pass: no more `window.prompt`), the same
   * pattern `warehouse-nav.tsx`'s `renameContainer` uses for a one-line hand
   * input outside a form, anchored to the row itself rather than reopening a
   * centered dialog for one field.
   */
  const retireNoteRow = useCallback(
    (id: string) => setRetiringNote({ id, anchor: noteRowRefs.current.get(id) ?? null }),
    [],
  );
  const submitRetireNote = useCallback(
    (id: string, reason: string) => {
      setRetiringNote(null);
      const trimmed = reason.trim();
      if (!trimmed) return;
      void fetch(`/api/spool/notes/${encodeURIComponent(id)}/retire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: trimmed }),
      }).then(() => {
        onChanged();
        void load();
      });
    },
    [onChanged, load],
  );

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  /**
   * IDENTITY BY HAND — loops §8, under §7's workbench principle: the hand and
   * the chat are the same ink. The swatches and the area input PATCH the same
   * subject record the chat's tools write, through the proxy's identity arm —
   * no turn is submitted, no model reads it, and the room's next snapshot
   * simply shows the hue everywhere identity already renders. A refusal is
   * the engine's sentence, inline and quiet, and the stored value stands.
   */
  const [identityRefused, setIdentityRefused] = useState<string | null>(null);
  const patchIdentity = useCallback(
    (patch: { area?: string | null; color?: string | null }) => {
      if (!subjectKey) return;
      void fetch(`/api/spool/subjects/${encodeURIComponent(subjectKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
          setIdentityRefused(null);
          onChanged();
        })
        .catch((err) => setIdentityRefused(err instanceof Error ? err.message : String(err)));
    },
    [subjectKey, onChanged],
  );
  const storedArea = record?.area ?? "";
  /** Blank clears — a corrected statement, not a deletion; `null` on the wire. */
  const commitArea = (value: string) => {
    const next = value.trim();
    if (next === storedArea) return;
    patchIdentity({ area: next || null });
  };

  /**
   * THE NULL KEY IS THE FILING FOLD'S OWN SET, not just the floating group: an
   * item with a subject and no lane (`unplaced`) is a filing chore too, and a
   * face that answered "nothing is unfiled" under a fold saying "1 thing needs
   * filing" would be two surfaces disagreeing about one store.
   */
  const allRows =
    subjectKey === null
      ? (view?.subjects ?? []).flatMap((g) => g.rows).filter((r) => !r.item.project || r.item.unplaced)
      : ((view?.subjects ?? []).find((g) => g.project === subjectKey)?.rows ?? []);
  /* §9.3: the face's ACTIVE list excludes closed items — they drain to the
     fold below, ticked, where unticking reopens. Nothing leaves the payload. */
  const rows = allRows.filter((r) => !r.item.closed);
  const doneRows = allRows.filter((r) => r.item.closed);

  /** How many observations are still unacknowledged — the face quotes the
   *  look's own label and counts its rows; it computes no time. */
  const unacked = (look?.look?.observations ?? []).filter((o) => !o.acknowledged).length;

  return (
    <div className="p-2">
      {/* ── WHERE THIS SUBJECT LIVES, AND WHEN THE SPOOL LAST LOOKED ─────────
             Terrain is stated in CHAT, not in a form here — `spool_set_terrain`
             is the master's move, so the no-terrain line teaches the words
             rather than growing a second write path. */}
      {subjectKey && (
        <div className="border-b border-border/60 px-2 pb-2">
          {look?.terrain ? (
            <>
              <p className="text-xs text-muted-foreground">
                lives in <span className="font-mono text-foreground">{look.terrain.repo}</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground/70">
                {look.look?.lastLooked
                  ? `${look.look.lastLooked}${unacked > 0 ? ` · ${unacked} ${unacked === 1 ? "thing" : "things"} moved` : ""}`
                  : "never looked yet"}
              </p>
            </>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground/70">
              The Spool doesn&rsquo;t know where this lives yet — tell the chat where this lives to let the Spool look.
            </p>
          )}
        </div>
      )}
      {/* ── WHOSE THIS IS — the identity controls, §8. Color marks the
             subject everywhere identity already renders; area groups its line
             in the wide stance. Both are statements the user makes — the
             swatch is the hand's spelling of the same fact the chat could
             record — and neither ever means anything about state. */}
      {subjectKey && (
        <div className="space-y-2 border-b border-border/60 px-2 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <SubjectDot color={record?.color} />
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {record?.area ?? "no area"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={`Identity color for ${subjectKey}`}>
            {SUBJECT_COLORS.map((token) => (
              <button
                key={token}
                type="button"
                role="radio"
                aria-checked={record?.color === token}
                aria-label={token}
                title={token}
                onClick={() => patchIdentity({ color: token })}
                className={cn(
                  "size-4 shrink-0 rounded-full outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
                  record?.color === token && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                )}
                style={{ backgroundColor: subjectColorVar(token) }}
              />
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={!record?.color}
              aria-label="none"
              title="none — the neutral dot"
              onClick={() => patchIdentity({ color: null })}
              className={cn(
                "size-4 shrink-0 rounded-full border border-dashed border-input outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
                !record?.color && "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
            />
          </div>
          {/* Free text with the existing areas offered — a new area is a word
              you are allowed to say. Keyed on the stored value so a landed
              PATCH re-seeds it with the store's own word. */}
          <Input
            key={storedArea}
            defaultValue={storedArea}
            list="subject-area-options"
            placeholder="Area — “Trabajo”, “Personal”…"
            aria-label={`Area for ${subjectKey}`}
            className="h-7 text-[0.6875rem] md:text-[0.6875rem]"
            onBlur={(event) => commitArea(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitArea(event.currentTarget.value);
              }
            }}
          />
          <datalist id="subject-area-options">
            {areas.map((area) => (
              <option key={area} value={area} />
            ))}
          </datalist>
          {identityRefused && (
            <p className="text-xs leading-relaxed text-muted-foreground">{identityRefused}</p>
          )}
        </div>
      )}
      {view === null && <p className="px-2 py-1 text-xs text-muted-foreground/60">Reading…</p>}
      {view !== null && rows.length === 0 && (
        <p className="px-2 py-1 text-xs leading-relaxed text-muted-foreground/60">
          {subjectKey ? `Nothing is filed to ${subjectKey}.` : "Nothing needs filing. Everything has a subject and a lane."}
        </p>
      )}
      <ul className="space-y-0.5">
        {rows.map(({ item, lane }) => {
          const said = (item.raw ?? "").trim().replace(/\s+/g, " ");
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpenItem(item.id)}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {/* TITLES level — the user's words, like every line in the room. */}
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{said || item.title}</span>
                {lane && <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground/60">{lane}</span>}
                {item.deadline && (
                  <span className="shrink-0">
                    <DeadlineChip deadline={item.deadline} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/* §9.3 — the face's done fold: drained, ticked, reopenable. */}
      {doneRows.length > 0 && (
        <div className="mt-2 border-t border-border/60 pt-1">
          <button
            type="button"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen((o) => !o)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", doneOpen && "rotate-90")} aria-hidden />
            Done — {doneRows.length}
          </button>
          {doneOpen && (
            <ul className="space-y-0.5 pt-0.5">
              {doneRows.map(({ item }) => {
                const said = (item.raw ?? "").trim().replace(/\s+/g, " ");
                const words = said || item.title;
                return (
                  <li key={item.id} className="flex items-start gap-1.5 rounded-md px-2 py-1.5">
                    <CloseCheckbox
                      closed
                      label={`Reopen “${words}”`}
                      onToggle={() => {
                        void reopenItemByHand(item.id)
                          .then(async () => {
                            setReopenRefused(null);
                            await load();
                            onChanged();
                          })
                          .catch((err) => setReopenRefused(err instanceof Error ? err.message : String(err)));
                      }}
                      className="mt-0.5"
                    />
                    <button
                      type="button"
                      onClick={() => onOpenItem(item.id)}
                      className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="block truncate text-sm font-medium text-muted-foreground/60">{words}</span>
                      {item.closed && (
                        <span className="block truncate text-[0.625rem] text-muted-foreground/60">
                          “closed {item.closed.label}”
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {reopenRefused && (
            <p className="px-2 pt-1 text-xs leading-relaxed text-muted-foreground">{reopenRefused}</p>
          )}
        </div>
      )}

      {/* ── THE SHELF — notes beside the items, loops §10.1. Knowledge is
             not work: no lane, no band, no checkbox — a title, its tags, and
             whose hand wrote it. Retired notes stay listed, dimmed, with the
             reason quoted: dismissing drains. */}
      <div className="mt-2 border-t border-border/60 pt-2">
        <div className="flex items-center gap-2 px-2 pb-1">
          <span className="flex-1 text-[0.6875rem] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">Notes</span>
          <button
            type="button"
            onClick={() => onNewNote(subjectKey ?? undefined)}
            className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
          >
            New note
          </button>
        </div>
        {notes.length === 0 && (
          <p className="px-2 py-1 text-xs leading-relaxed text-muted-foreground/60">Nothing on the shelf here yet.</p>
        )}
        <ul className="space-y-0.5">
          {notes.map((note) => (
            <li key={note.id}>
              <ContextMenu>
                <ContextMenuTrigger>
                  <button
                    ref={(el) => {
                      if (el) noteRowRefs.current.set(note.id, el);
                      else noteRowRefs.current.delete(note.id);
                    }}
                    type="button"
                    onClick={() => onOpenNote(note.id)}
                    className="block w-full min-w-0 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-sm font-medium",
                          note.retired ? "text-muted-foreground/50" : "text-foreground",
                        )}
                      >
                        {note.title}
                      </span>
                      {note.author === "session" && (
                        <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground/60">agent&rsquo;s note</span>
                      )}
                      {note.tags.map((tag) => (
                        <span key={tag} className="shrink-0 font-mono text-[0.625rem] text-muted-foreground/60">
                          #{tag}
                        </span>
                      ))}
                    </span>
                    {note.retired && (
                      <span className="block truncate text-[0.625rem] text-muted-foreground/50">
                        retired {note.retired.label} — “{note.retired.reason}”
                      </span>
                    )}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => onOpenNote(note.id)}>Open</ContextMenuItem>
                  {!note.retired && <ContextMenuItem onClick={() => retireNoteRow(note.id)}>Retire…</ContextMenuItem>}
                </ContextMenuContent>
              </ContextMenu>
              <AskOneThing
                open={retiringNoteId === note.id}
                onOpenChange={(next) => {
                  if (!next) setRetiringNote(null);
                }}
                anchor={retiringNote?.id === note.id ? retiringNote.anchor : null}
                label="Retire this note — why?"
                placeholder="No longer true because…"
                onSubmit={(reason) => submitRetireNote(note.id, reason)}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * THE GRANTS, AS A FACE. §7.6 is standing state the human authored — the
 * room's whole answer to per-night consent leans on it — so it has to stay
 * reachable after the queue fold died. One row per subject, the shared chip.
 */
/** The ceiling control's vocabulary — the same levels the grant speaks, plus
 *  the one honest absence. "" is the select's spelling of `null` on the wire:
 *  no ceiling, the ordinary case, never a level the system assumed. */
const CEILING_OPTIONS: Array<{ value: "" | SpoolSubjectPermits; label: string }> = [
  { value: "", label: "no ceiling" },
  { value: "read", label: "may read" },
  { value: "draft", label: "may draft" },
  { value: "propose", label: "may propose" },
];

function PermitsFace() {
  const [subjects, setSubjects] = useState<SpoolSubject[]>([]);
  /** The EFFECTIVE permit per subject — the threads read's word, which is the
   *  stated grant clamped by the area's ceiling. Read, never recomputed here:
   *  the engine's `effectivePermits` is the one function in front of every
   *  enforcement point, and this face quotes its answer. */
  const [effective, setEffective] = useState<Record<string, SpoolSubjectPermits>>({});
  /**
   * THE WINNING PREFIX — `docs/spool-loops.md` §13.7: an area name is a path,
   * and every prefix's ceiling clamps down it, most restrictive wins. The
   * subject's own `area` is NOT always the segment that clamped it — an
   * ancestor's ceiling can be the one that won — so the threads read's own
   * `clampedBy` (the exact prefix responsible) rides beside `effective`
   * rather than the sentence below re-deriving or assuming it.
   */
  const [clampedBy, setClampedBy] = useState<Record<string, string | undefined>>({});
  /** The stated ceiling records — only areas someone stated a ceiling for.
   *  An area missing from this list has NO ceiling, and renders as exactly
   *  that; nothing here writes a record to make the list complete. */
  const [areaRecords, setAreaRecords] = useState<SpoolArea[]>([]);
  /** A refused ceiling, per area — the engine's sentence, inline and quiet,
   *  while the stored value stands. */
  const [refused, setRefused] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [subjectsRes, mapRes, areasRes] = await Promise.all([
        fetch("/api/spool/subjects"),
        // The threads map is where the clamp is visible: its `permits` is the
        // effective level, while `subject.permits` above stays the stated one.
        fetch("/api/spool/threads"),
        fetch("/api/spool/areas"),
      ]);
      if (subjectsRes.ok) setSubjects(((await subjectsRes.json()).subjects ?? []) as SpoolSubject[]);
      if (mapRes.ok) {
        const map = (await mapRes.json()) as SpoolMap;
        setEffective(Object.fromEntries((map.subjects ?? []).map((s) => [s.subject, s.permits])));
        setClampedBy(Object.fromEntries((map.subjects ?? []).map((s) => [s.subject, s.clampedBy])));
      }
      if (areasRes.ok) setAreaRecords(((await areasRes.json()).areas ?? []) as SpoolArea[]);
    } catch {
      // A dropped read leaves the last good list. Grants are standing state;
      // nothing here has changed because a request failed.
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  /**
   * STATE A CEILING — the ONE write path to `/api/spool/areas/`, and it runs
   * on the user's change and nowhere else. NEVER auto-PATCHed: rendering an
   * area without a record shows "no ceiling" rather than writing one, because
   * a ceiling is a statement the user makes, never a default the face fills
   * in. `null` withdraws — a corrected statement, not a deletion.
   */
  const setCeiling = useCallback(
    (name: string, ceiling: SpoolSubjectPermits | null) => {
      void fetch(`/api/spool/areas/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ceiling }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
          setRefused((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== name)));
          await load();
        })
        .catch((err) => setRefused((prev) => ({ ...prev, [name]: err instanceof Error ? err.message : String(err) })));
    },
    [load],
  );

  /** Every area that exists anywhere — the union of what subjects reference
   *  and what carries a stated record — so a ceiling can be stated for a
   *  group the user has only ever filed under. */
  const areaNames = [
    ...new Set([
      ...subjects.map((s) => s.area).filter((a): a is string => !!a),
      ...areaRecords.map((a) => a.name),
    ]),
  ].sort((a, b) => a.localeCompare(b));

  return (
    <div className="p-3">
      <p className="mb-2 text-xs leading-relaxed text-muted-foreground/70">
        What the night may do for each subject, unattended. Your grant — it counts nothing and asks nothing.
      </p>
      <ul className="space-y-1">
        {subjects.map((subject) => {
          /* THE CLAMP, SHOWN AND NEVER SILENT — loops §8.1. The chip holds
             the STATED grant (yours, and still yours to change); when the
             area's ceiling lowers what actually runs, the sentence says so in
             plain words, quoting the area's name. No colour, no alarm — a
             clamp is standing policy you stated, not a state to attend to. */
          const stated = subject.permits;
          const acts = effective[subject.key];
          const clamped = acts !== undefined && acts !== stated;
          // The prefix that actually won — §13.7: a ceiling on an ANCESTOR
          // segment ("Work") clamps every subject nested under it ("Work /
          // Focaltec"), so `subject.area` (the subject's own, full path) is
          // not always the segment responsible. `clampedBy` names the exact
          // winner; older data that predates the field falls back to the
          // subject's own area rather than showing nothing.
          const clampSource = clampedBy[subject.key] ?? subject.area;
          return (
            <li key={subject.key} className="rounded-md px-2 py-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{subject.name}</span>
                <PermitsChip subject={subject.key} permits={stated} onChanged={() => void load()} />
              </span>
              {clamped && (
                <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
                  {stated} — clamped to {acts} by &ldquo;{clampSource}&rdquo;&rsquo;s ceiling
                </p>
              )}
            </li>
          );
        })}
        {subjects.length === 0 && <li className="px-2 text-xs text-muted-foreground/60">No subjects yet.</li>}
      </ul>
      {areaNames.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs leading-relaxed text-muted-foreground/70">
            Areas. A ceiling caps every subject filed under the area — down, never up — and exists only when you
            state one.
          </p>
          <ul className="space-y-1">
            {areaNames.map((name) => {
              const record = areaRecords.find((a) => a.name === name);
              return (
                <li key={name} className="rounded-md px-2 py-1.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">{name}</span>
                    <select
                      aria-label={`Ceiling for ${name}`}
                      title={`The most any subject under ${name} may do unattended`}
                      value={record?.ceiling ?? ""}
                      onChange={(event) =>
                        setCeiling(name, (event.currentTarget.value || null) as SpoolSubjectPermits | null)
                      }
                      className="h-5 shrink-0 rounded-sm border border-border bg-transparent px-1 text-[0.625rem] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {CEILING_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </span>
                  {refused[name] && (
                    <p className="mt-0.5 text-[0.625rem] leading-relaxed text-muted-foreground">{refused[name]}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {/* THE CONNECT CARD USED TO LIVE HERE (loops §10.3) — REHOMED
          (2026-08-18) to the Warehouse's own Connections tab
          (`warehouse.tsx`'s `ConnectionsTab`), not duplicated: this face
          keeps only the per-area ceiling control above. */}
    </div>
  );
}

export function SpoolTray({
  face,
  work,
  subjects,
  lanes,
  map,
  onOpenItem,
  onOpenNote,
  onNewNote,
  onClose,
  onChanged,
  onBackToChat,
  onExpand,
}: {
  face: TrayFace;
  work: SpoolWorkView;
  /** The subject records from the room's one snapshot read — the subject
   *  face's identity join, so the tray never fetches what the room holds. */
  subjects: SpoolSubject[];
  /** The lanes from the same snapshot — the packet face's filing select. */
  lanes: SpoolLane[];
  /** The threads map from the same snapshot — the packet face's hand verbs
   *  read it to find the open thread already holding a capture. */
  map: SpoolMap | null;
  /** A face naming another item — a night job row, say — swaps the tray to
   *  that packet. Same summoning verb the stance uses. */
  onOpenItem: (id: string) => void;
  /** The shelf's summons — a note face, or the fresh-note face. */
  onOpenNote: (id: string) => void;
  onNewNote: (subjectKey?: string) => void;
  onClose: () => void;
  onChanged: () => void;
  /** §13.6 — THE SUMMONED LAYER'S OTHER DOOR. The layer holds ONE slot,
   *  conversation XOR a face; while a face is up this returns to the
   *  conversation without closing the layer. Omitted entirely (no button)
   *  when the caller has no layer to go back into. */
  onBackToChat?: () => void;
  /** §13.6's "expand door-join" — the layer's header control that trades
   *  the whole overlay for the Assistant room. Omitted when the tray is not
   *  hosted inside the layer (there is no room to expand into). */
  onExpand?: () => void;
}) {
  return (
    <section aria-label="Spool tray" className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{faceTitle(face)}</span>
        <span className="flex-1" />
        {onBackToChat && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back to chat"
            title="Back to chat"
            onClick={onBackToChat}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <MessageSquareIcon className="size-4" />
          </Button>
        )}
        {onExpand && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Expand to the Assistant room"
            title="Expand to the Assistant room"
            onClick={onExpand}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Maximize2Icon className="size-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close the tray"
          title="Close the tray"
          onClick={onClose}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {face.kind === "packet" && (
          <PacketFace
            key={face.id}
            id={face.id}
            work={work}
            lanes={lanes}
            subjectKeys={subjects.map((s) => s.key)}
            map={map}
            onChanged={onChanged}
          />
        )}
        {face.kind === "night" && <NightSurface work={work} onOpen={onOpenItem} onChanged={onChanged} />}
        {face.kind === "memory" && <MemorySurface />}
        {face.kind === "permits" && <PermitsFace />}
        {face.kind === "subject" && (
          <SubjectFace
            key={face.key ?? "__unfiled"}
            subjectKey={face.key}
            record={subjects.find((s) => s.key === face.key)}
            areas={[...new Set(subjects.map((s) => s.area).filter((a): a is string => !!a))].sort((a, b) => a.localeCompare(b))}
            onOpenItem={onOpenItem}
            onOpenNote={onOpenNote}
            onNewNote={onNewNote}
            onChanged={onChanged}
          />
        )}
        {face.kind === "note" && (
          <NoteFace key={face.id} id={face.id} onOpenNote={onOpenNote} onChanged={onChanged} />
        )}
        {face.kind === "note-new" && (
          <NoteFace
            key={`__new:${face.subjectKey ?? ""}`}
            id={null}
            {...(face.subjectKey ? { subjectKey: face.subjectKey } : {})}
            onOpenNote={onOpenNote}
            onChanged={onChanged}
          />
        )}
      </div>
    </section>
  );
}
