"use client";

import { useState } from "react";
import {
  MAX_AUTO_SETTLE_HOURS,
  MIN_AUTO_SETTLE_HOURS,
  DEFAULT_AUTO_SETTLE_HOURS,
  DEFAULT_SETTLE_DELEGATED_AFTER_HOURS,
  DEFAULT_INBOX_POLICY,
  DEFAULT_SETTLED_TERMINAL_LIMIT,
  MAX_SETTLED_TERMINAL_LIMIT,
} from "@telar/engine-client";
import { usePathname } from "next/navigation";
import { useInboxPolicy } from "../inbox-policy";
import { hostFromPathname } from "@/lib/hosts/client";
import { LOCAL_HOST_ID } from "@telar/engine-client";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Row, SettingsGroup, useRestoreDefaults } from "@/features/settings";

type Unit = "hours" | "days";

const HOURS_PER: Record<Unit, number> = { hours: 1, days: 24 };
const MAX_BY_UNIT: Record<Unit, number> = { hours: MAX_AUTO_SETTLE_HOURS, days: MAX_AUTO_SETTLE_HOURS / 24 };

function unitFor(hours: number): Unit {
  return hours % 24 === 0 ? "days" : "hours";
}

function WindowInput({ hours, onCommit, label }: { hours: number; onCommit: (hours: number) => void; label: string }) {
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

function CountInput({ value, onCommit, label }: { value: number; onCommit: (value: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value));
  const [last, setLast] = useState(value);
  if (last !== value) {
    setLast(value);
    setDraft(String(value));
  }
  return (
    <Input
      type="number"
      min={0}
      max={MAX_SETTLED_TERMINAL_LIMIT}
      className="w-20"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (event.target.value !== "" && Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_SETTLED_TERMINAL_LIMIT) onCommit(parsed);
      }}
      onBlur={() => setDraft(String(value))}
      aria-label={label}
    />
  );
}

export function InboxSection() {
  const { policy, loading, save, error } = useInboxPolicy();
  const pathname = usePathname();
  const hours = policy.autoSettleAfterHours;
  const delegated = policy.settleDelegatedAfterHours;
  const terminalLimit = policy.settledTerminalLimit ?? DEFAULT_SETTLED_TERMINAL_LIMIT;
  useRestoreDefaults(() =>
    save({
      autoSettleAfterHours: DEFAULT_INBOX_POLICY.autoSettleAfterHours,
      settleDelegatedAfterHours: DEFAULT_INBOX_POLICY.settleDelegatedAfterHours,
      settledTerminalLimit: DEFAULT_SETTLED_TERMINAL_LIMIT,
    }),
  );

  return (
    <SettingsGroup title="Settling" scope={hostFromPathname(pathname ?? "/") === LOCAL_HOST_ID ? "mac" : "host"}>
      <Row
        label="Settle quiet sessions"
        {...(error ? { error } : {})}
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
          label="Settle quiet sessions after"
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
          label="Settle delegated conversations after"
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
      <Row
        label="Terminals settled sessions may keep open"
        info="Counted across every project on this Mac, shells you opened included. Past it, the session settled longest ago has its terminals closed first, and its row says so. Settling one yourself closes its terminals at once; one settled automatically keeps them for 30 minutes."
        {...(terminalLimit === DEFAULT_SETTLED_TERMINAL_LIMIT
          ? {}
          : { onRevert: () => void save({ settledTerminalLimit: DEFAULT_SETTLED_TERMINAL_LIMIT }) })}
        control={
          <CountInput
            value={terminalLimit}
            label="How many terminals settled sessions may keep open"
            onCommit={(next) => void save({ settledTerminalLimit: next })}
          />
        }
      />
    </SettingsGroup>
  );
}
