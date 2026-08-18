"use client";

/**
 * THE LOBBY — `docs/spool-loops.md` §13.2, the room's default landing.
 *
 * MISSION CONTROL, RANKED NEVER ENUMERATED. This is a pure read of
 * `GET /v2/spool/lobby` (`lib/engine/*` → `/api/spool/lobby`): the engine
 * already decided which subjects earn a card and which fold — see
 * `SpoolLobbySubject.folded` in `packages/engine-client`'s protocol — so
 * this file renders that answer. It never re-derives urgency, never sorts
 * by a clock, and it holds no local idea of which subject "matters more"
 * than another; the fold IS the ranking.
 *
 * A CARD, ONLY WHEN `!folded`. Everything else compresses to one quiet
 * line per area: "N subjects, nothing needs you" — §13.2's whole point,
 * that a lobby which enumerated every subject would be the old wide stance
 * wearing a new name.
 */
import { useCallback, useEffect, useState } from "react";
import type { SpoolLobby, SpoolLobbySubject, SpoolSubject, SpoolLane } from "@telar/engine-client";
import { SubjectDot } from "@/components/spool/chips";
import { todayDay } from "@/lib/spool-today";
import { AddTaskDialog } from "@/components/spool/add-task";

function SessionLiveMark({ live }: { live: boolean | null }) {
  if (!live) return null;
  // Quiet text, never a badge — §13.2's own wording for a live session.
  return <span className="shrink-0 text-[11px] text-muted-foreground/70">session running</span>;
}

function LobbyCard({ subject, onEnter }: { subject: SpoolLobbySubject; onEnter: (key: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onEnter(subject.key)}
      className="flex w-full flex-col gap-1 rounded-lg bg-card px-4 py-3 text-left shadow-sm ring-1 ring-foreground/10 transition-colors hover:ring-foreground/20"
    >
      <div className="flex min-w-0 items-center gap-2">
        <SubjectDot color={subject.color} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{subject.name}</span>
        <SessionLiveMark live={subject.sessionLive} />
      </div>
      {subject.needsYou > 0 && (
        <p className="text-xs text-muted-foreground">
          {subject.needsYou} {subject.needsYou === 1 ? "thing needs" : "things need"} you
        </p>
      )}
      {subject.moved.line && (
        <p className="truncate text-xs leading-relaxed text-muted-foreground/80">“{subject.moved.line}”</p>
      )}
      {subject.nextPin && (
        <p className="text-xs text-muted-foreground/70">pinned — {subject.nextPin.label}</p>
      )}
    </button>
  );
}

function AreaFold({ names, needing }: { names: string[]; needing: number }) {
  if (needing > 0) {
    // A fold never hides a claim on the hand — this only happens when
    // `folded` is true, which the engine already guarantees means
    // needsYou===0 for every member, so this branch is defensive only.
    return null;
  }
  return (
    <p className="px-1 py-1 text-xs text-muted-foreground/60">
      {names.length} {names.length === 1 ? "subject" : "subjects"}, nothing needs you
    </p>
  );
}

function AreaSection({
  name,
  ceiling,
  subjects,
  onEnter,
}: {
  name?: string;
  ceiling?: string;
  subjects: SpoolLobbySubject[];
  onEnter: (key: string) => void;
}) {
  const cards = subjects.filter((s) => !s.folded);
  const folded = subjects.filter((s) => s.folded);
  if (subjects.length === 0) return null;
  return (
    <div className="space-y-2">
      {name && (
        <div className="flex items-baseline gap-2 px-1">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground/70 uppercase">{name}</p>
          {ceiling && <span className="text-[11px] text-muted-foreground/50">ceiling: {ceiling}</span>}
        </div>
      )}
      {cards.map((s) => (
        <LobbyCard key={s.key} subject={s} onEnter={onEnter} />
      ))}
      {folded.length > 0 && <AreaFold names={folded.map((s) => s.key)} needing={0} />}
    </div>
  );
}

export function Lobby({
  onEnterSubject,
  onChanged,
}: {
  onEnterSubject: (key: string) => void;
  /** Fired after the add-task dialog lands one — the room's own reload,
   *  never a second store the lobby keeps for itself. */
  onChanged?: () => void;
}) {
  const [lobby, setLobby] = useState<SpoolLobby | null>(null);
  const [subjects, setSubjects] = useState<SpoolSubject[]>([]);
  const [lanes, setLanes] = useState<SpoolLane[]>([]);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const today = todayDay();
      const [lobbyRes, subjectsRes, laneRes] = await Promise.all([
        fetch(`/api/spool/lobby?today=${encodeURIComponent(today)}`),
        fetch("/api/spool/subjects"),
        fetch("/api/spool/lanes"),
      ]);
      if (lobbyRes.ok) setLobby((await lobbyRes.json()).lobby as SpoolLobby);
      if (subjectsRes.ok) setSubjects(((await subjectsRes.json()).subjects ?? []) as SpoolSubject[]);
      if (laneRes.ok) setLanes(((await laneRes.json()).lanes ?? []) as SpoolLane[]);
    } catch {
      // Pull-based, like every other Spool surface — a dropped read leaves
      // the last good lobby up.
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  const subjectNames = [...lobby?.areas.flatMap((a) => a.subjects) ?? [], ...(lobby?.unareaed ?? [])].map((s) => s.key);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      <div className="mb-4 flex items-center justify-between px-1">
        <p className="text-xs leading-relaxed text-muted-foreground">
          What needs you, ranked — nothing else is enumerated.
        </p>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-spool/40 hover:text-foreground"
        >
          Add a task
        </button>
      </div>

      {!lobby && <p className="px-1 text-xs text-muted-foreground/60">Reading…</p>}

      {lobby && lobby.areas.length === 0 && lobby.unareaed.length === 0 && (
        <p className="px-1 text-xs leading-relaxed text-muted-foreground/60">Nothing filed yet.</p>
      )}

      {lobby && (
        <div className="space-y-6">
          {lobby.areas.map((area) => (
            <AreaSection key={area.name} name={area.name} ceiling={area.ceiling} subjects={area.subjects} onEnter={onEnterSubject} />
          ))}
          {lobby.unareaed.length > 0 && (
            <AreaSection subjects={lobby.unareaed} onEnter={onEnterSubject} />
          )}
        </div>
      )}

      <AddTaskDialog
        open={adding}
        onOpenChange={setAdding}
        subjects={subjectNames}
        lanes={lanes}
        onCreated={() => {
          void load();
          onChanged?.();
        }}
      />
    </div>
  );
}
