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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The same labelled field the Spool's other forms wear (cf `dialogs.tsx`). */
function Field({ htmlFor, label, hint, children }: { htmlFor: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function AddTaskDialog({
  open,
  onOpenChange,
  subjects,
  lanes,
  defaultSubject,
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
  /** The room's reload — the new card arrives by snapshot, not by echo. */
  onCreated: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a task</DialogTitle>
          <DialogDescription>
            Written straight to the store, by your hand — no model reads it until you next talk. Agents notice it the
            same way they notice everything else: it is simply there.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted fresh per open (the `key` in spirit): state lives below so
            reopening starts blank rather than carrying the last attempt. */}
        {open && (
          <AddTaskForm
            subjects={subjects}
            lanes={lanes}
            {...(defaultSubject === undefined ? {} : { defaultSubject })}
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
  onDone,
}: {
  subjects: string[];
  lanes: SpoolLane[];
  defaultSubject?: string;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState(defaultSubject ?? "");
  const [lane, setLane] = useState("");
  const [deadlineLabel, setDeadlineLabel] = useState("");
  const [deadlineKind, setDeadlineKind] = useState<"external" | "self">("self");
  const [pinDay, setPinDay] = useState("");
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
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field htmlFor="task-title" label="Title">
        <Input
          id="task-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What is it?"
          autoFocus
        />
      </Field>

      <Field htmlFor="task-subject" label="Subject" hint="An existing subject, or a new word — both are yours to say.">
        <Input
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
      </Field>

      {lanes.length > 0 && (
        <Field htmlFor="task-lane" label="Lane">
          <Select value={lane} onValueChange={(next) => setLane(next ?? "")}>
            <SelectTrigger size="sm" id="task-lane" className="w-full">
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
        </Field>
      )}

      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Field
          htmlFor="task-deadline"
          label="Deadline"
          hint="Your own words — “Friday”, “end of month”. A chip you chose to look at, never an alarm."
        >
          <Input
            id="task-deadline"
            value={deadlineLabel}
            onChange={(event) => setDeadlineLabel(event.target.value)}
            placeholder="Optional"
          />
        </Field>
        <Field htmlFor="task-deadline-kind" label="Whose">
          <Select
            value={deadlineKind}
            onValueChange={(next) => setDeadlineKind(next === "external" ? "external" : "self")}
          >
            <SelectTrigger size="sm" id="task-deadline-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="self">mine</SelectItem>
              <SelectItem value="external">external</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field htmlFor="task-pin" label="Pin to a day" hint="Optional. Picking a day is you stating it — it shows on the calendar and joins Needs you when the day comes.">
        <Input id="task-pin" type="date" value={pinDay} onChange={(event) => setPinDay(event.target.value)} />
      </Field>

      {refused && (
        <Alert variant="destructive">
          <AlertDescription className="text-xs break-words">{refused}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
        <Button type="submit" size="sm" disabled={busy || !title.trim()}>
          {busy && <Loader2Icon className="animate-spin" />}
          Add it
        </Button>
      </DialogFooter>
    </form>
  );
}
