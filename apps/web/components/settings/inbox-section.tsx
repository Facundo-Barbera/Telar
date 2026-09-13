"use client";

/**
 * INBOX — how the rail decides what you still have to look at.
 *
 * Ported from t3 code's General settings panel: one switch for whether quiet
 * sessions leave the list at all, and one duration for how long "quiet" is.
 *
 * THE WINDOW IS STORED IN HOURS and shown in the unit that reads best: a
 * multiple of 24 displays as days, anything else as hours. Hour granularity
 * arrived when a reader with twenty quiet-but-recent conversations had no
 * number that would take them — a day was the old minimum. The unit select
 * converts the VALUE with it (2 days ⇄ 48 hours name the same instant), so
 * switching units never silently changes the window.
 *
 * IT IS ONE SETTING SHOWN AS TWO ROWS, and that is deliberate rather than
 * decorative. "Never" is not a number of hours — someone who wants an inbox
 * that only changes when they change it needs a way to say so. The second row
 * appears only when the first is on.
 */

import { useState } from "react";
import {
  MAX_AUTO_SETTLE_HOURS,
  MIN_AUTO_SETTLE_HOURS,
  DEFAULT_AUTO_SETTLE_HOURS,
  DEFAULT_SETTLE_DELEGATED_AFTER_HOURS,
  DEFAULT_INBOX_POLICY,
} from "@telar/engine-client";
import { useInboxPolicy } from "@/lib/inbox-policy";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row, SettingsGroup, useRestoreDefaults } from "./settings-shell";

type Unit = "hours" | "days";

const HOURS_PER: Record<Unit, number> = { hours: 1, days: 24 };
const MAX_BY_UNIT: Record<Unit, number> = { hours: MAX_AUTO_SETTLE_HOURS, days: MAX_AUTO_SETTLE_HOURS / 24 };

/** The unit a stored window reads best in — days only when it IS whole days. */
function unitFor(hours: number): Unit {
  return hours % 24 === 0 ? "days" : "hours";
}

/**
 * A duration you can EMPTY while typing.
 *
 * Committing on every keystroke against the persisted value would make the
 * field un-clearable — delete the "3" and it snaps back before you can type
 * "14". So a local draft holds whatever is on screen, the setting moves only
 * on a valid whole number in range, and blur restores the field to what
 * actually saved.
 *
 * THE RESYNC IS A RENDER-PHASE ADJUSTMENT, not an effect — React's own
 * guidance for "adjust state when a prop changes", and this app's lint
 * enforces it.
 */
function WindowInput({ hours, onCommit, label }: { hours: number; onCommit: (hours: number) => void; label: string }) {
  // INVARIANT: `unit` only ever says "days" while `hours` divides by 24 —
  // both resync paths below maintain it, so `hours / HOURS_PER[unit]` is
  // always whole.
  const [unit, setUnit] = useState<Unit>(unitFor(hours));
  const [draft, setDraft] = useState(String(hours / HOURS_PER[unitFor(hours)]));
  const [lastHours, setLastHours] = useState(hours);
  if (lastHours !== hours) {
    setLastHours(hours);
    const nextUnit: Unit = hours % HOURS_PER[unit] === 0 ? unit : "hours";
    if (nextUnit !== unit) setUnit(nextUnit);
    setDraft(String(hours / HOURS_PER[nextUnit]));
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        min={1}
        max={MAX_BY_UNIT[unit]}
        className="w-20"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          // `Number`, not `parseInt`: "3.5" must be REJECTED rather than
          // truncated to a committed 3 while the field still shows 3.5.
          const parsed = Number(event.target.value);
          const asHours = parsed * HOURS_PER[unit];
          if (Number.isInteger(parsed) && asHours >= MIN_AUTO_SETTLE_HOURS && asHours <= MAX_AUTO_SETTLE_HOURS) onCommit(asHours);
        }}
        onBlur={() => setDraft(String(hours / HOURS_PER[unit]))}
        aria-label={label}
      />
      <Select
        value={unit}
        onValueChange={(next) => {
          // The unit CONVERTS the value rather than reinterpreting it — 2
          // days ⇄ 48 hours name the same window, so switching units must
          // never move it. A window that is not whole days stays in hours.
          if (next !== "hours" && next !== "days") return;
          if (hours % HOURS_PER[next] !== 0) return;
          setUnit(next);
          setDraft(String(hours / HOURS_PER[next]));
        }}
      >
        <SelectTrigger size="sm" className="w-24">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="hours">hours</SelectItem>
          <SelectItem value="days">days</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function InboxSection() {
  const { policy, loading, save, error } = useInboxPolicy();
  const hours = policy.autoSettleAfterHours;
  const delegated = policy.settleDelegatedAfterHours;
  useRestoreDefaults(() =>
    save({
      autoSettleAfterHours: DEFAULT_INBOX_POLICY.autoSettleAfterHours,
      settleDelegatedAfterHours: DEFAULT_INBOX_POLICY.settleDelegatedAfterHours,
    }),
  );

  return (
    // NO CAPTION. "Settle quiet sessions" with a switch beside it is the whole
    // sentence; the caption and the sub-line under it were two more ways of
    // saying the same thing (#357). What survives is on "After", because the
    // carve-out is the one fact neither the title nor the control can carry.
    <SettingsGroup title="Settling">
      <Row
        label="Settle quiet sessions"
        {...(error ? { error } : {})}
        // The engine's answer is the state, so a refused write leaves the
        // switch showing what is stored — the error says so beneath it.
        {...((hours === null) === (DEFAULT_INBOX_POLICY.autoSettleAfterHours === null)
          ? {}
          : { onRevert: () => void save({ autoSettleAfterHours: DEFAULT_INBOX_POLICY.autoSettleAfterHours }) })}
        control={
          <Switch
            checked={hours !== null}
            disabled={loading}
            onCheckedChange={(next: boolean) => void save({ autoSettleAfterHours: next ? DEFAULT_AUTO_SETTLE_HOURS : null })}
            aria-label="Settle quiet sessions"
          />
        }
      />
      {hours !== null && (
        <Row
          label="After"
          hint="Pinned sessions and open questions stay put."
          {...(hours === DEFAULT_AUTO_SETTLE_HOURS
            ? {}
            : { onRevert: () => void save({ autoSettleAfterHours: DEFAULT_AUTO_SETTLE_HOURS }) })}
          control={
            <WindowInput
              hours={hours}
              label="How long a session must be quiet before it settles"
              onCommit={(next) => void save({ autoSettleAfterHours: next })}
            />
          }
        />
      )}
      {/*
        THE SECOND CLOCK, AND IT IS NOT THE FIRST ONE — issue #378.

        A DELIVERED ERRAND IS NOT A QUIET SESSION. The window above guesses from
        silence, which is why its default is three days; this one counts from a
        fact the engine stamped — the coordinator has the result — so an hour is
        enough. Sharing a number would have made one of the two wrong.

        ONE SWITCH AND ONE DURATION, the shape the group already uses. The row
        appears whatever the quiet clock is set to: they are independent
        answers, and nesting this under "Settle quiet sessions" would say
        otherwise.
      */}
      <Row
        label="Settle delegated conversations after their result is delivered"
        control={
          <Switch
            checked={delegated !== null}
            disabled={loading}
            onCheckedChange={(next: boolean) =>
              void save({ settleDelegatedAfterHours: next ? DEFAULT_SETTLE_DELEGATED_AFTER_HOURS : null })
            }
            aria-label="Settle delegated conversations after their result is delivered"
          />
        }
        {...((delegated === null) === (DEFAULT_INBOX_POLICY.settleDelegatedAfterHours === null)
          ? {}
          : { onRevert: () => void save({ settleDelegatedAfterHours: DEFAULT_INBOX_POLICY.settleDelegatedAfterHours }) })}
      />
      {delegated !== null && (
        <Row
          label="After"
          hint="A failed errand, a pinned row and an open question all stay put."
          {...(delegated === DEFAULT_SETTLE_DELEGATED_AFTER_HOURS
            ? {}
            : { onRevert: () => void save({ settleDelegatedAfterHours: DEFAULT_SETTLE_DELEGATED_AFTER_HOURS }) })}
          control={
            <WindowInput
              hours={delegated}
              label="How long after delivery a delegated conversation settles"
              onCommit={(next) => void save({ settleDelegatedAfterHours: next })}
            />
          }
        />
      )}
    </SettingsGroup>
  );
}
