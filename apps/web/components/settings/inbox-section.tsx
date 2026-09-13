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
import { MAX_AUTO_SETTLE_HOURS, MIN_AUTO_SETTLE_HOURS, DEFAULT_AUTO_SETTLE_HOURS, DEFAULT_INBOX_POLICY } from "@telar/engine-client";
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
function WindowInput({ hours, onCommit }: { hours: number; onCommit: (hours: number) => void }) {
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
        aria-label="How long a session must be quiet before it settles"
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
  useRestoreDefaults(() => save({ autoSettleAfterHours: DEFAULT_INBOX_POLICY.autoSettleAfterHours }));

  return (
    <SettingsGroup title="Settling" description="A settled session is off your list, not finished.">
      <Row
        label="Settle quiet sessions"
        hint={error ?? "Off means nothing leaves the list on its own."}
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
          hint="Time without activity. Pinned sessions and open questions stay put."
          control={<WindowInput hours={hours} onCommit={(next) => void save({ autoSettleAfterHours: next })} />}
        />
      )}
    </SettingsGroup>
  );
}
