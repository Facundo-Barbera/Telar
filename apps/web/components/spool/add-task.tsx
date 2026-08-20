"use client";

/**
 * CREATING BY HAND — `docs/spool-loops.md` §7.1, the workbench's first piece.
 *
 * A plain form writing straight to the store through the human API, with ZERO
 * model involvement: no turn is submitted, no session touched, no run created.
 * "Your hand and its hand are the same ink" — the POST lands in the same store
 * every agent reads, so a hand-made task is part of the ingest with no extra
 * wiring: the chat sees it next turn, reconcile can tie it to the world, the
 * night can map it. On success the room reloads its snapshot and the new card
 * is simply there, indistinguishable in standing from one an agent filed.
 *
 * SUBJECT AND LANE ARE THE STORE'S OWN, offered rather than invented: the
 * subject field lists the subjects that exist and still takes free text — a
 * new subject is a word you are allowed to say — while the lane select offers
 * only the lanes that exist, because a lane that does not exist is never
 * created by side effect (the capture route's own law).
 *
 * THE PIN IS A DATE THE USER STATES. A plain `<input type="date">` — the user
 * picking a day IS the user stating it, which is what keeps `pinned` inside
 * §3.2-as-amended's human-owned boundary. The engine refuses a malformed day
 * with a plain sentence, surfaced verbatim below the form.
 */
import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import type { SpoolLane } from "@telar/engine-client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FieldGroup, FieldRow, RowInput } from "@/components/spool/field-group";

export function AddTaskDialog({
  open,
  onOpenChange,
  subjects,
  lanes,
  defaultSubject,
  defaultPinDay,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The subjects that exist, for the datalist. Free text stays legal. */
  subjects: string[];
  /** The lanes that exist, in stored order. None is a resting state. */
  lanes: SpoolLane[];
  /** Focused rooms seed their subject — the aperture is already a statement. */
  defaultSubject?: string;
  /** The calendar day cell's own "Add a task for this day…" verb seeds this —
   *  the SAME `pinned` field the form's own date input already writes,
   *  merely pre-picked rather than left blank; no new field, no new route. */
  defaultPinDay?: string;
  /** The room's reload — the new card arrives by snapshot, not by echo. */
  onCreated: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Compact card, not ceremony — no description paragraph; the title
          alone is enough, and the sr-only text below carries the "your
          hand" disclosure for anyone reading with assistive tech without
          spending a visible line of screen ceremony on it. */}
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="sr-only">
          <DialogTitle>Add a task</DialogTitle>
        </DialogHeader>
        {/* Mounted fresh per open (the `key` in spirit): state lives below so
            reopening starts blank rather than carrying the last attempt. */}
        {open && (
          <AddTaskForm
            subjects={subjects}
            lanes={lanes}
            {...(defaultSubject === undefined ? {} : { defaultSubject })}
            {...(defaultPinDay === undefined ? {} : { defaultPinDay })}
            onDone={() => {
              onOpenChange(false);
              onCreated();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddTaskForm({
  subjects,
  lanes,
  defaultSubject,
  defaultPinDay,
  onDone,
}: {
  subjects: string[];
  lanes: SpoolLane[];
  defaultSubject?: string;
  defaultPinDay?: string;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState(defaultSubject ?? "");
  const [lane, setLane] = useState("");
  const [deadlineLabel, setDeadlineLabel] = useState("");
  const [deadlineKind, setDeadlineKind] = useState<"external" | "self">("self");
  const [pinDay, setPinDay] = useState(defaultPinDay ?? "");
  const [busy, setBusy] = useState(false);
  /** The store's sentence, rendered in place. Never invented here. */
  const [refused, setRefused] = useState<string | null>(null);

  const submit = () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setRefused(null);
    void (async () => {
      try {
        const res = await fetch("/api/spool/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            ...(subject.trim() ? { project: subject.trim() } : {}),
            ...(lane ? { lane } : {}),
            ...(deadlineLabel.trim() ? { deadline: { label: deadlineLabel.trim(), kind: deadlineKind } } : {}),
            ...(pinDay ? { pinned: { day: pinDay } } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
        onDone();
      } catch (err) {
        setRefused(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {/* THE TITLE INPUT IS THE CARD'S OWN HEADER — Reminders' own grammar:
          no "Title" label, no border, larger than the rows beneath it. The
          dialog's a11y title stays (sr-only, above) for assistive tech. */}
      <input
        id="task-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="What is it?"
        autoFocus
        className="w-full border-none bg-transparent px-1 text-base font-medium text-foreground outline-none placeholder:text-muted-foreground/60"
      />

      <FieldGroup>
        <FieldRow label="Subject" htmlFor="task-subject" hint="An existing subject, or a new word — both are yours to say.">
          <RowInput
            id="task-subject"
            list="task-subject-options"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Leave blank to file it later"
          />
          <datalist id="task-subject-options">
            {subjects.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </FieldRow>

        {lanes.length > 0 && (
          <FieldRow label="Lane" htmlFor="task-lane">
            <Select value={lane} onValueChange={(next) => setLane(next ?? "")}>
              <SelectTrigger size="sm" id="task-lane" className="w-full border-none bg-transparent shadow-none">
                <SelectValue placeholder="Where its work tends to happen" />
              </SelectTrigger>
              <SelectContent>
                {lanes.map((l) => (
                  <SelectItem key={l.key} value={l.key}>
                    {l.label}
                    {l.window ? ` — ${l.window}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
        )}

        <FieldRow
          label="Deadline"
          htmlFor="task-deadline"
          hint="Your own words — “Friday”, “end of month”. A chip you chose to look at, never an alarm."
        >
          <div className="flex items-center justify-end gap-2">
            <RowInput
              id="task-deadline"
              value={deadlineLabel}
              onChange={(event) => setDeadlineLabel(event.target.value)}
              placeholder="Optional"
              className="text-left"
            />
            <Select
              value={deadlineKind}
              onValueChange={(next) => setDeadlineKind(next === "external" ? "external" : "self")}
            >
              <SelectTrigger size="sm" id="task-deadline-kind" className="w-auto shrink-0 border-none bg-transparent shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="self">mine</SelectItem>
                <SelectItem value="external">external</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </FieldRow>

        <FieldRow
          label="Pin to a day"
          htmlFor="task-pin"
          hint="Optional. Picking a day is you stating it — it shows on the calendar and joins Needs you when the day comes."
        >
          <RowInput id="task-pin" type="date" value={pinDay} onChange={(event) => setPinDay(event.target.value)} />
        </FieldRow>
      </FieldGroup>

      {refused && <p className="px-1 text-xs break-words text-muted-foreground">{refused}</p>}

      <DialogFooter className="-mx-4 -mb-4 border-t-0 bg-transparent p-0 pt-1">
        <DialogClose render={<Button type="button" variant="ghost" size="sm" />}>Cancel</DialogClose>
        <Button type="submit" size="sm" disabled={busy || !title.trim()}>
          {busy && <Loader2Icon className="animate-spin" />}
          Add it
        </Button>
      </DialogFooter>
    </form>
  );
}
