"use client";

/**
 * A SUBJECT'S OWN IDENTITY ROWS — ONE DEFINITION SITE, per the Warehouse
 * brief: `warehouse.tsx`'s Subjects tab and `room.tsx`'s new About tab both
 * need "area, color, rank, terrain, permits" for one subject, and a second
 * hand-rolled copy of these fields would be exactly the drift the brief
 * warns about. Everything here writes through routes that already exist —
 * `PATCH /api/spool/subjects/:key` with `{area}`/`{color}`/`{terrain}`
 * (`tray.tsx`'s `SubjectFace.patchIdentity` and the new terrain arm the web
 * proxy already carries, see `apps/web/app/api/spool/subjects/[key]/route.ts`)
 * — and `PermitsChip` (`permits.tsx`), reused as-is rather than re-spelled.
 *
 * RANK IS DISPLAY-ONLY HERE. The brief is explicit: "the Warehouse displays
 * it but does not edit it" — the rail's own drag-to-reorder
 * (`warehouse-nav.tsx`) is the one hand that writes it.
 *
 * COLOR STAYS A CLOSED ENUM — `SUBJECT_COLORS`, the engine's own token set,
 * never free hex; the same swatch grammar `tray.tsx`'s `SubjectFace` already
 * draws, restated here rather than imported because that one is wired to
 * `tray.tsx`'s own local `identityRefused` state and isn't exported.
 *
 * TERRAIN'S ONE SHAPE TODAY is `{kind:"github-repo", repo, notes?}`
 * (`SpoolTerrain`, a discriminated union of exactly one member right now).
 * The row therefore reads as "does this subject live in a repo, yes/no" —
 * clearing the repo field clears terrain outright (`null` on the wire, a
 * corrected statement, never a deletion of the subject).
 *
 * THE FieldGroup/FieldRow/RowInput IDIOM, not the older swatch-and-bare-
 * `Input` layout `tray.tsx`'s `SubjectFace` still carries — the brief calls
 * for every new surface to speak the Reminders-style sheet, and this is a
 * new surface.
 */
import { useState } from "react";
import type { SpoolSubject, SpoolSubjectPermits } from "@telar/engine-client";
import { FieldGroup, FieldRow, RowInput } from "@/components/spool/field-group";
import { PermitsChip } from "@/components/spool/permits";
import { SUBJECT_COLORS, subjectColorVar } from "@/components/spool/subject-color";
import { cn } from "@/lib/utils";

export function SubjectIdentityFields({
  subjectKey,
  record,
  areas,
  onChanged,
}: {
  subjectKey: string;
  record: SpoolSubject | undefined;
  /** Every area that exists across the records — the datalist, same offer
   *  `tray.tsx`'s own area input already makes. */
  areas: string[];
  onChanged: () => void;
}) {
  const [refused, setRefused] = useState<string | null>(null);
  const storedArea = record?.area ?? "";
  const [repoDraft, setRepoDraft] = useState(record?.terrain?.repo ?? "");
  const [notesDraft, setNotesDraft] = useState(record?.terrain?.notes ?? "");

  const patch = (body: Record<string, unknown>) => {
    void fetch(`/api/spool/subjects/${encodeURIComponent(subjectKey)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
        setRefused(null);
        onChanged();
      })
      .catch((err) => setRefused(err instanceof Error ? err.message : String(err)));
  };

  const commitArea = (value: string) => {
    const next = value.trim();
    if (next === storedArea) return;
    patch({ area: next || null });
  };

  /** Commit whatever the two terrain fields currently hold. A blank repo
   *  clears terrain outright — there is no "half a terrain" on the wire. */
  const commitTerrain = (repo: string, notes: string) => {
    const trimmedRepo = repo.trim();
    if (!trimmedRepo) {
      if (record?.terrain) patch({ terrain: null });
      return;
    }
    const trimmedNotes = notes.trim();
    const next = { kind: "github-repo" as const, repo: trimmedRepo, ...(trimmedNotes ? { notes: trimmedNotes } : {}) };
    if (record?.terrain?.repo === next.repo && (record.terrain.notes ?? "") === (next.notes ?? "")) return;
    patch({ terrain: next });
  };

  return (
    <div className="space-y-3">
      <FieldGroup>
        <FieldRow label="Area" htmlFor={`identity-area-${subjectKey}`}>
          <RowInput
            key={storedArea}
            id={`identity-area-${subjectKey}`}
            defaultValue={storedArea}
            list={`identity-area-options-${subjectKey}`}
            placeholder="no area"
            onBlur={(event) => commitArea(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitArea(event.currentTarget.value);
              }
            }}
          />
          <datalist id={`identity-area-options-${subjectKey}`}>
            {areas.map((area) => (
              <option key={area} value={area} />
            ))}
          </datalist>
        </FieldRow>
        <FieldRow label="Color">
          <span className="flex flex-wrap items-center justify-end gap-1.5" role="radiogroup" aria-label={`Identity color for ${subjectKey}`}>
            {SUBJECT_COLORS.map((token) => (
              <button
                key={token}
                type="button"
                role="radio"
                aria-checked={record?.color === token}
                aria-label={token}
                title={token}
                onClick={() => patch({ color: token })}
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
              onClick={() => patch({ color: null })}
              className={cn(
                "size-4 shrink-0 rounded-full border border-dashed border-input outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
                !record?.color && "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
            />
          </span>
        </FieldRow>
        <FieldRow label="Order" hint="Set by dragging in the rail's Areas tree — this row only shows it.">
          <span className="text-sm text-muted-foreground">{record?.rank !== undefined ? record.rank + 1 : "unranked"}</span>
        </FieldRow>
        <FieldRow label="Permits">
          <PermitsChip subject={subjectKey} permits={record?.permits ?? "draft"} onChanged={onChanged} />
        </FieldRow>
      </FieldGroup>

      <FieldGroup>
        <FieldRow label="Repo" htmlFor={`identity-repo-${subjectKey}`} hint="owner/name, exactly as gh -R takes it. Blank clears where this lives.">
          <RowInput
            id={`identity-repo-${subjectKey}`}
            value={repoDraft}
            placeholder="owner/name"
            onChange={(event) => setRepoDraft(event.target.value)}
            onBlur={() => commitTerrain(repoDraft, notesDraft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitTerrain(repoDraft, notesDraft);
              }
            }}
          />
        </FieldRow>
        <FieldRow label="Notes" htmlFor={`identity-terrain-notes-${subjectKey}`} hint="Prose for a model — “milestones are Hitos”, “needs-approval is the accept gate”.">
          <RowInput
            id={`identity-terrain-notes-${subjectKey}`}
            value={notesDraft}
            onChange={(event) => setNotesDraft(event.target.value)}
            onBlur={() => commitTerrain(repoDraft, notesDraft)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitTerrain(repoDraft, notesDraft);
              }
            }}
          />
        </FieldRow>
      </FieldGroup>

      {refused && <p className="px-1 text-xs leading-relaxed text-muted-foreground">{refused}</p>}
    </div>
  );
}
