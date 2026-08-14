"use client";

/**
 * INBOX — how the rail decides what you still have to look at.
 *
 * Ported from t3 code's General settings panel: one switch for whether quiet
 * sessions leave the list at all, and one number for how long "quiet" is. Same
 * 1..90 bound, same default of three days.
 *
 * IT IS ONE SETTING SHOWN AS TWO ROWS, and that is deliberate rather than
 * decorative. "Never" is not a number of days — a very large window still
 * settles things eventually, and someone who wants an inbox that only ever
 * changes when they change it needs a way to say so. The second row appears
 * only when the first is on, so the app never asks you to configure something
 * you just switched off.
 *
 * THE PIN AND THE SNOOZE HAVE NO ROWS HERE. They are per-session decisions
 * taken on the row itself, and a settings pane listing them could only offer to
 * undo them in bulk — which is the sidebar's job, one row at a time.
 */

import { useState } from "react";
import { MAX_AUTO_SETTLE_DAYS, MIN_AUTO_SETTLE_DAYS, DEFAULT_AUTO_SETTLE_DAYS } from "@telar/engine-client";
import { useInboxPolicy } from "@/lib/inbox-policy";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Row, SettingsGroup } from "./settings-shell";

/**
 * A number field you can EMPTY while typing.
 *
 * Committing on every keystroke against the persisted value would make the
 * field un-clearable — delete the "3" and it snaps back before you can type
 * "14". So a local draft holds whatever is on screen, the setting moves only on
 * a valid whole number in range, and blur restores the field to what actually
 * saved. t3's `AutoSettleDaysInput`, verbatim in behaviour.
 *
 * THE RESYNC IS A RENDER-PHASE ADJUSTMENT, not an effect. The donor uses
 * `useEffect`; React's own guidance for "adjust state when a prop changes" is
 * to compare against the last value during render, and this app's lint enforces
 * it. Same result, one render earlier, and no flash of the stale number.
 */
function DaysInput({ value, onCommit }: { value: number; onCommit: (days: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value) {
    setLastValue(value);
    setDraft(String(value));
  }

  return (
    <Input
      type="number"
      min={MIN_AUTO_SETTLE_DAYS}
      max={MAX_AUTO_SETTLE_DAYS}
      className="w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // `Number`, not `parseInt`: "3.5" must be REJECTED rather than
        // truncated to a committed 3 while the field still shows 3.5.
        const parsed = Number(event.target.value);
        if (Number.isInteger(parsed) && parsed >= MIN_AUTO_SETTLE_DAYS && parsed <= MAX_AUTO_SETTLE_DAYS) onCommit(parsed);
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="Days of quiet before a session settles"
    />
  );
}

export function InboxSection() {
  const { policy, loading, save, error } = useInboxPolicy();
  const days = policy.autoSettleAfterDays;

  return (
    <SettingsGroup
      title="Settling"
      description="A settled session is off your list, not finished. It comes back the moment you send it anything."
    >
      <Row
        label="Settle quiet sessions"
        hint={
          error ??
          "Off means nothing leaves the list on its own — only what you settle, snooze or pin."
        }
        control={
          <Switch
            checked={days !== null}
            disabled={loading}
            onCheckedChange={(next: boolean) => void save({ autoSettleAfterDays: next ? DEFAULT_AUTO_SETTLE_DAYS : null })}
            aria-label="Settle quiet sessions"
          />
        }
      />
      {days !== null && (
        <Row
          label="After"
          hint={`Days without activity. Anything you pin stays put; anything that asks you a question comes back.`}
          control={<DaysInput value={days} onCommit={(next) => void save({ autoSettleAfterDays: next })} />}
        />
      )}
    </SettingsGroup>
  );
}
