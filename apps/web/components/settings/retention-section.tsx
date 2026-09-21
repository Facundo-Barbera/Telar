"use client";

/**
 * HOW LONG TELAR KEEPS THE RAW TURN JOURNAL — issues #542 and #646.
 *
 * ══ THE MEASUREMENT IS THE FEATURE, NOT A CONFIRMATION DIALOG ══
 *
 * A retention window is the one setting on this pane that DELETES, and the only
 * honest way to offer one is with the reader's own numbers beside it before
 * they choose. A fixed default is what destroys the install whose oldest
 * session is a week old; "1 session, 340 events, 2.1 MB" in front of somebody is
 * the defence no cleverer default provides. So every window is priced against
 * THIS store, and the price is fetched before anything can be set.
 *
 * ══ BYTES ARE AN EXPLICIT ASK ══
 *
 * Session and event counts are index ranges; the byte sum reads every
 * qualifying row's text, which on a gigabyte is a real scan. So the pane opens
 * with counts and a person presses for the size. Nothing here is on a timer —
 * #629 is open because four timers in the rail cost ~97,000 requests a day.
 *
 * ══ "FREED" MEANS TWO DIFFERENT THINGS AND THE COPY SAYS SO ══
 *
 * A DELETE moves pages to sqlite's freelist: the database holds less and the
 * file weighs the same. Measured next door — #646's compaction dropped 570,951
 * rows and left the file at 1005.6 MiB to the byte until a VACUUM brought it to
 * 695.1 MiB. A person who deletes their history irreversibly, looks at Storage
 * and sees the same number has been given the worst possible outcome. So this
 * section ends by sending them to the Reclaim button above it, and never claims
 * bytes of its own.
 *
 * ══ AND THE JOURNAL IS MOVED, NOT DESTROYED ══
 *
 * The window cannot be set without somewhere to write the export, so what a
 * sweep does is take a settled session's journal out of the database and put it
 * in NDJSON files the person owns. That is a weaker promise than "irreversible"
 * and it is the one the code can keep — and it is why the copy says the space
 * comes back when they delete those files, rather than when the sweep runs.
 */

import { useCallback, useEffect, useState } from "react";
import type { JournalRetirement, RetentionBucket, RetentionPolicy } from "@telar/engine-client";
import { ArchiveIcon, FolderDownIcon, HistoryIcon } from "lucide-react";
import { createEngineApi } from "@/lib/engine/client";
import { chooseDirectory } from "@/lib/choose-directory";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row, SettingsGroup } from "./settings-shell";

const api = createEngineApi();

/** What one window costs, in the register a person reads rather than a row of
 *  numbers. Zero is a sentence of its own: a window that would take nothing is
 *  the answer somebody needs most, and "0 sessions" reads like a failure. */
export function bucketLabel(bucket: RetentionBucket): string {
  if (bucket.sessions === 0) return "nothing yet — no conversation here is that old";
  const sessions = `${bucket.sessions.toLocaleString()} ${bucket.sessions === 1 ? "conversation" : "conversations"}`;
  const events = `${bucket.events.toLocaleString()} journal ${bucket.events === 1 ? "row" : "rows"}`;
  return bucket.bytes === undefined ? `${sessions}, ${events}` : `${sessions}, ${events}, ${formatBytes(bucket.bytes)}`;
}

/**
 * WHAT ONE SWEEP DID — counts, never bytes.
 *
 * `skipped` IS NEVER HIDDEN, and it is not an error either. A session whose
 * turn summaries do not account for its journal, or whose item projection will
 * not parse, is left exactly as it was — which is the guard working. Saying so
 * is the difference between a person trusting the number and wondering why
 * their store did not change.
 */
export function sweepLabel(swept: JournalRetirement): string {
  if (swept.retired === 0 && swept.skipped === 0) return "Nothing was old enough to retire.";
  const retired = `Retired ${swept.retired.toLocaleString()} ${swept.retired === 1 ? "conversation" : "conversations"} — ${swept.events.toLocaleString()} journal rows exported, then dropped.`;
  const skipped = swept.skipped === 0
    ? ""
    : ` ${swept.skipped.toLocaleString()} ${swept.skipped === 1 ? "was" : "were"} left alone, because what survives the journal did not yet account for it.`;
  // TWO STEPS, BOTH NAMED, AND IN ORDER (#542). "Freed" means two different
  // things here and a person who reads only the first will conclude the sweep
  // did nothing: the rows leave the database and the file weighs the same until
  // Reclaim rewrites it, and the bytes are still on the disk until they delete
  // the exports, because retention MOVES the journal rather than destroying it.
  // Saying only "press Reclaim" would promise space that does not arrive.
  return `${retired}${skipped} The exports are yours to keep or delete — the disk gets the space back when you delete them, and the database shrinks when you press Reclaim above.`;
}

export function RetentionSection() {
  const [policy, setPolicy] = useState<RetentionPolicy>();
  const [buckets, setBuckets] = useState<RetentionBucket[]>([]);
  const [busy, setBusy] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [swept, setSwept] = useState<string | undefined>(undefined);

  const load = useCallback(async (bytes: boolean) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const answer = await api.retention(bytes ? { bytes: true } : {});
      setPolicy(answer.retention);
      setBuckets(answer.buckets);
    } catch {
      setFailure("Telar could not measure what a window would take — the engine did not answer.");
    } finally {
      setBusy(false);
    }
  }, []);

  /** ONCE, ON OPEN, and without the byte scan. `StorageSection`'s rule, for the
   *  same reason: the pane paints before anything asks the engine to count. */
  useEffect(() => {
    const task = window.setTimeout(() => void load(false), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const save = async (patch: { idleAfterDays?: number | null; exportTo?: string | null }) => {
    setBusy(true);
    setFailure(undefined);
    setSwept(undefined);
    try {
      setPolicy((await api.setRetention(patch)).retention);
    } catch (cause) {
      // The refusal a person most often meets is "choose where the journal is
      // exported first", and it is the engine's sentence rather than one
      // composed here — one place states the rule.
      setFailure(cause instanceof Error ? cause.message : "That window could not be set.");
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    const chosen = await chooseDirectory({ title: "Choose where Telar should write retired conversation journals" });
    if (!("path" in chosen)) {
      if ("unavailable" in chosen) setFailure(chosen.unavailable);
      return;
    }
    await save({ exportTo: chosen.path });
  };

  const sweep = async () => {
    setSweeping(true);
    setFailure(undefined);
    setSwept(undefined);
    try {
      setSwept(sweepLabel((await api.sweepRetention()).swept));
      // Re-measure rather than doing arithmetic on the figures on screen: the
      // press changed the store, and a row still showing the old count would
      // say the press did nothing.
      await load(buckets.some((bucket) => bucket.bytes !== undefined));
    } catch {
      setFailure("Telar could not run the sweep — the engine did not answer.");
    } finally {
      setSweeping(false);
    }
  };

  const window_ = policy?.idleAfterDays ?? null;
  const chosen = buckets.find((bucket) => bucket.days === window_);

  return (
    <SettingsGroup
      title="How long the turn journal is kept"
      description="The step-by-step record an agent can grep and replay. Transcripts, the rail and search are kept elsewhere and are not touched."
    >
      <Row
        icon={FolderDownIcon}
        label="Export retired journals to"
        hint={
          policy?.exportTo
            ? `${policy.exportTo} — a folder per conversation, in the same shape a whole-store export writes. Nothing is dropped from the database until its copy is written and counted, so retiring MOVES a journal rather than destroying it: the disk gets that space back when you delete the exports.`
            : "Choose a folder first. Nothing is deleted until a copy has been written out."
        }
        {...(failure ? { error: failure } : {})}
        control={
          <span className="flex items-center gap-2">
            {policy?.exportTo ? (
              <Button size="sm" variant="ghost" disabled={busy || sweeping} onClick={() => void save({ idleAfterDays: null, exportTo: null })}>
                Clear
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={busy || sweeping} onClick={() => void choose()}>
              {policy?.exportTo ? "Change…" : "Choose…"}
            </Button>
          </span>
        }
      />
      <Row
        icon={HistoryIcon}
        label="Retire journals idle longer than"
        hint={
          window_ === null
            ? "Never. Each window below shows what it would free before you choose."
            : `${chosen ? bucketLabel(chosen) : "…"} would be retired the next time the sweep runs.`
        }
        control={
          <span className="flex items-center gap-2">
            {busy ? <Spinner className="size-3.5" /> : null}
            <Select
              value={window_ === null ? "never" : String(window_)}
              disabled={busy || sweeping || !policy?.exportTo}
              onValueChange={(value) => void save({ idleAfterDays: value === "never" ? null : Number(value) })}
            >
              <SelectTrigger size="sm" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never">Never</SelectItem>
                {buckets.map((bucket) => (
                  <SelectItem key={bucket.days} value={String(bucket.days)}>
                    {`${bucket.days} days — ${bucket.sessions.toLocaleString()}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </span>
        }
      />
      {/*
        WHAT EACH WINDOW WOULD TAKE, ALL OF THEM AT ONCE — because the choice is
        between four numbers and not between 29 and 30 days. The byte figure is
        behind a press for the reason the header gives: counts are index ranges
        and the sum is a scan.
      */}
      <Row
        icon={ArchiveIcon}
        label="What each window would take"
        hint={buckets.length === 0 ? "Measured when this pane opens." : buckets.map((bucket) => `${bucket.days}d: ${bucketLabel(bucket)}`).join(" · ")}
        control={
          <span className="flex items-center gap-2">
            {buckets.some((bucket) => bucket.bytes !== undefined) ? null : (
              <Button size="sm" variant="ghost" disabled={busy || sweeping} onClick={() => void load(true)}>
                Measure size
              </Button>
            )}
            {/*
              THE FIRST RUN IS A DISTINCT ACT — the approved design is explicit
              that enabling a window must not have the next startup quietly
              delete the backlog. Afterwards the ordinary housekeeping sweep
              keeps up, and this button reports "nothing was old enough".
            */}
            <Button size="sm" variant="outline" disabled={busy || sweeping || window_ === null} onClick={() => void sweep()}>
              {sweeping ? "Retiring…" : "Retire now"}
            </Button>
          </span>
        }
      />
      {swept ? <Row icon={ArchiveIcon} label="Last sweep" hint={swept} /> : null}
    </SettingsGroup>
  );
}
